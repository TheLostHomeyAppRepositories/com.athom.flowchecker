"use strict";

const Homey = require("homey");
const HomeyAPI = require("athom-api").HomeyAPI;
const flowConditions = require('./lib/flows/conditions');
const { sleep } = require('./lib/helpers');

const _settingsKey = `${Homey.manifest.id}.settings`;

class App extends Homey.App {
  log() {
    console.log.bind(this, "[log]").apply(this, arguments);
  }

  error() {
    console.error.bind(this, "[error]").apply(this, arguments);
  }

  // -------------------- INIT ----------------------

  async onInit() {
    this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);

    await this.initSettings();

    this.log("[onInit] - Loaded settings", this.appSettings);

    this._api = await HomeyAPI.forCurrentHomey(this.homey);

    await flowConditions.init(this.homey);

    await this.findFlowDefects(true);
  }

  // -------------------- SETTINGS ----------------------

  async initSettings() {
    try {
      let settingsInitialized = false;
      this.homey.settings.getKeys().forEach((key) => {
        if (key == _settingsKey) {
          settingsInitialized = true;
        }
      });

      if (settingsInitialized) {
        this.log("[initSettings] - Found settings key", _settingsKey);
        this.appSettings = this.homey.settings.get(_settingsKey);

        if(!this.appSettings.BROKEN_VARIABLE) {
            await this.updateSettings({
                ...this.appSettings,
                BROKEN_VARIABLE: [],
                NOTIFICATION_BROKEN_VARIABLE: true
              });
        }
      } else {
        this.log(`Initializing ${_settingsKey} with defaults`);
        await this.updateSettings({
          BROKEN: [],
          DISABLED: [],
          BROKEN_VARIABLE: [],
          NOTIFICATION_BROKEN: true,
          NOTIFICATION_DISABLED: false,
          NOTIFICATION_BROKEN_VARIABLE: true
        });
      }
    } catch (err) {
      this.error(err);
    }
  }

  async updateSettings(settings) {
    try {
      this.log("[updateSettings] - New settings:", settings);
      this.appSettings = settings;
      
      await this.homey.settings.set(_settingsKey, this.appSettings);  
    } catch (error) {
      this.error(err);
    }
  }

// -------------------- FUNCTIONS ----------------------

    async setFindFlowsInterval(REFRESH = 3) {
      const REFRESH_INTERVAL = 1000 * (REFRESH * 60);

      this.log(`[onPollInterval]`, REFRESH, REFRESH_INTERVAL);
      this.onPollInterval = setInterval(this.findFlowDefects.bind(this), REFRESH_INTERVAL);
    }
  
    async findFlowDefects(initial = false) {
      try {
        await this.findFlows('BROKEN');
        await this.findFlows('DISABLED');
        await this.findLogic('BROKEN_VARIABLE');

        if(initial) {
            await sleep(9000);
            await this.setFindFlowsInterval()
        }
      } catch (error) {
        this.error(error);
      }
    }

    async findFlows(key) {
        const flowArray = this.appSettings[key];

        this.log(`[findFlows] ${key} - FlowArray: `, flowArray);
        let flows = [];

        if(key === 'BROKEN') {
          flows = Object.values(await this._api.flow.getFlows({ filter: { broken: true } }));
        } else if(key === 'DISABLED') {
          flows = Object.values(await this._api.flow.getFlows({ filter: { enabled: false } }));
        }

        flows = flows.map((f) => ({name: f.name, id: f.id}));
    
        if (flowArray.length !== flows.length) {
          await this.updateSettings({...this.appSettings, [key]: [...new Set(flows)]});
          await this.checkFlowDiff(key, flows, flowArray);
        }
    }

    async findLogic(key) {
        const brokenLogicFlows = this.appSettings[key];

        this.log(`[findLogic] ${key} - brokenLogicFlows: `, brokenLogicFlows);

        let logicVariables = Object.values(await this._api.logic.getVariables());
        logicVariables = logicVariables.map((f) => (`homey:manager:logic|${f.id}`));
        this.log(`[findLogic] ${key} - logicVariables: `, logicVariables);
        
        const flows = Object.values(await this._api.flow.getFlows({ filter: { broken: false, enabled: true } }));
        
        let filteredFlows = flows.filter(flow =>  {
            const trigger = flow.trigger.uri === 'homey:manager:logic' ? flow.trigger : {};
            const conditions = flow.conditions;
            const actions = flow.actions;

            if(trigger.uri === 'homey:manager:logic' && !logicVariables.includes(trigger.args.variable.id)) {
                return true;
            }

            if(conditions.some(c => c.droptoken && c.droptoken.includes('homey:manager:logic') && !logicVariables.includes(c.droptoken))){
                return true;
            }

            return actions.some(f => {
                const argsArray = f.args && Object.values(f.args) || [];
                if (!argsArray || !argsArray.length) return false;
                const logic = argsArray.find(arg => typeof arg === 'string' && arg.includes('homey:manager:logic'));                
                
                if(logic) {
                    return !logicVariables.includes(logic.substring(logic.indexOf("[[") + 2,  logic.lastIndexOf("]]")));
                }

                return false;
            });
        });
        
        filteredFlows = filteredFlows.map((f) => ({name: f.name, id: f.id}));

        this.log(`[findLogic] ${key} - filteredFlows: `, filteredFlows);

        if (brokenLogicFlows.length !== filteredFlows.length) {
            await this.updateSettings({...this.appSettings, [key]: [...new Set(filteredFlows)]});
            await this.checkFlowDiff(key, filteredFlows, brokenLogicFlows)
        }
    }

    async checkFlowDiff(key, flows, flowArray) {
      try {
        const flowDiff = flows.filter(x => !flowArray.includes(x));
        const flowDiffReverse = flowArray.filter(x => !flows.includes(x));

        this.log(`[flowDiff] ${key} - flowDiff: `, flowDiff);
        this.log(`[flowDiff] ${key} - flowDiffReverse: `, flowDiffReverse);
  
        if(flowDiff.length) {
          flowDiff.forEach(async flow =>  {
            await this.setNotification(key, flow.name, 'Flow');
            await this.homey.flow.getTriggerCard(`trigger_${key}`).trigger({flow: flow.name, id: flow.id})
                .catch( this.error )
                .then(this.log(`[flowDiff] ${key} - Triggered: "${flow.name} | ${flow.id}"`)); 
          });
        }

        if(flowDiffReverse.length) {
            flowDiffReverse.forEach(async flow =>  {
              await this.homey.flow.getTriggerCard(`trigger_FIXED`).trigger({flow: flow.name, id: flow.id})
                  .catch( this.error )
                  .then(this.log(`[flowDiff] FIXED - Triggered: "${flow.name} | ${flow.id}"`)); 
            });
        }
      } catch (error) {
        this.error(error);
      }
     
    }

    async setNotification(key, flow, type) {
      try {
        if(this.appSettings[`NOTIFICATION_${key}`]) {
            await this.homey.notifications.createNotification({
            excerpt: `FlowChecker -  Event: ${key} - ${type}: **${flow}**`,
            });
        }
      } catch (error) {
        this.error(error);
      }
    }
}

module.exports = App;
