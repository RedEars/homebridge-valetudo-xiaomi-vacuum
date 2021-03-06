"use strict";

const http = require("http");
const urllib = require("url");

var Accessory, Service, Characteristic, UUIDGen;

module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerAccessory(
    "homebridge-valetudo-xiaomi-vacuum",
    "ValetudoXiaomiVacuum",
    ValetudoXiaomiVacuum
  );
};

class ValetudoXiaomiVacuum {
  constructor(log, config) {
    this.services = [];
    this.log = log;
    this.name = config.name || "Vacuum";

    let powerControl = config["power-control"];
    if (powerControl) {
      let defaultSpeedValue = this.getSpeedValue(
        powerControl["default-speed"] || "quiet"
      );
      let highSpeedValue = this.getSpeedValue(
        powerControl["high-speed"] || "turbo"
      );

      this.powerControl = {
        defaultSpeed: defaultSpeedValue,
        highSpeed: highSpeedValue,
        mop: powerControl["mop-enabled"]
      };

      this.log.debug(
        `Setting power control: default speed - ${this.powerControl.defaultSpeed}, high speed - ${this.powerControl.highSpeed}, mop enabled - ${this.powerControl.mop}`
      );
    }

    this.ip = config.ip;
    this.current_status = null;
    this.status_callbacks = new Array();
    this.current_status_time = null;
    this.status_timer = null;
    this.spots = config.spots;

    if (!this.ip) {
      throw new Error("You must provide an ip address of the vacuum cleaner.");
    }

    // HOMEKIT SERVICES
    this.serviceInfo = new Service.AccessoryInformation();
    this.serviceInfo
      .setCharacteristic(Characteristic.Manufacturer, "Xiaomi")
      .setCharacteristic(Characteristic.Model, "Roborock");

    this.serviceInfo
      .getCharacteristic(Characteristic.FirmwareRevision)
      .on("get", this.getVersion.bind(this));
    this.services.push(this.serviceInfo);

    this.findService = new Service.Switch("Find " + this.name, "identify");
    this.findService
      .getCharacteristic(Characteristic.On)
      .on("set", this.doFind.bind(this));
    this.services.push(this.findService);

    this.goHomeService = new Service.Switch("Go Home, " + this.name, "home");
    this.goHomeService
      .getCharacteristic(Characteristic.On)
      .on("set", this.goHome.bind(this))
      .on("get", this.isGoingHome.bind(this));
    this.services.push(this.goHomeService);

    this.cleanService = new Service.Switch("Clean, " + this.name, "clean");
    this.cleanService
      .getCharacteristic(Characteristic.On)
      .on("set", this.startCleaning.bind(this))
      .on("get", this.isCleaning.bind(this));
    this.services.push(this.cleanService);

    if (this.powerControl) {
      this.highSpeedService = new Service.Switch(
        "High speed mode " + this.name,
        "highspeed"
      );
      this.highSpeedService
        .getCharacteristic(Characteristic.On)
        .on("set", this.setHighSpeedMode.bind(this))
        .on("get", this.getHighSpeedMode.bind(this));
      this.services.push(this.highSpeedService);

      if (this.powerControl.mop) {
        this.mopService = new Service.Switch(
          "Mopping mode " + this.name,
          "mopspeed"
        );
        this.mopService
          .getCharacteristic(Characteristic.On)
          .on("set", this.setMopMode.bind(this))
          .on("get", this.getMopMode.bind(this));
        this.services.push(this.mopService);
      }
    }

    this.speakerService = new Service.Speaker(this.name, "speaker");
    this.speakerService
      .getCharacteristic(Characteristic.Volume)
      .on("set", this.setVolume.bind(this))
      .on("get", this.getVolume.bind(this));
    this.speakerService
      .getCharacteristic(Characteristic.Mute)
      .on("set", this.setMute.bind(this))
      .on("get", this.getMute.bind(this));
    this.services.push(this.speakerService);

    this.batteryService = new Service.BatteryService(this.name + " Battery");
    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .on("get", this.getBattery.bind(this));
    this.batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .on("get", this.getCharging.bind(this));
    this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .on("get", this.getBatteryLow.bind(this));
    this.services.push(this.batteryService);

    if (this.spots) {
      this.log(`Spots retrieved ${JSON.stringify(this.spots)}`);
      for (let index = 0; index < this.spots.length; index++) {
        const spot = this.spots[index];
        this.log(`Add spot ${JSON.stringify(spot)}`);
        this.spotCleanService = new Service.Switch(
          spot["name"] + ", " + this.name,
          "spotclean"
        );
        this.spotCleanService
          .getCharacteristic(Characteristic.On)
          .on("set", this.startSpotCleaning.bind(this, spot))
          .on("get", this.isSpotCleaning.bind(this));
        this.services.push(this.spotCleanService);
      }
    }

    this.updateStatus(true);
  }

  getHighSpeedMode(callback) {
    this.getStatus(false, error => {
      if (error) {
        callback(error);
      } else {
        callback(
          null,
          this.current_status["fan_power"] === this.powerControl.highSpeed
        );
      }
    });
  }

  getMopMode(callback) {
    this.getStatus(false, error => {
      if (error) {
        callback(error);
      } else {
        callback(
          null,
          this.current_status["fan_power"] === ValetudoXiaomiVacuum.SPEEDS.mop
        );
      }
    });
  }

  getConfig(callback) {
    this.log(`Getting config`);
    this.sendJSONRequest("http://" + this.ip + "/api/get_config", "GET")
      .then(response => {
        this.log(`Config retrieved ${JSON.stringify(response)}`);
        this.valetudo_config = response;
        callback(response);
      })
      .catch(e => {
        this.log.error(`Failed to get config: ${e}`);
        callback();
      });
  }

  setFanSpeed(value, callback) {
    this.log.debug(`Setting fan power to ${value}`);
    this.sendJSONRequest("http://" + this.ip + "/api/fanspeed", "PUT", {
      speed: value
    })
      .then(response => {
        callback();
        this.updateStatus(true);
      })
      .catch(e => {
        this.log.error(`Failed to change fan power: ${e}`);
        callback();
      });
  }

  setHighSpeedMode(on, callback) {
    if (on) {
      if (this.highSpeedMode) {
        callback(null);
        return;
      } else {
        this.setFanSpeed(this.powerControl.highSpeed, callback);
        return;
      }
    } else {
      if (this.highSpeedMode) {
        this.setFanSpeed(this.powerControl.defaultSpeed, callback);
        return;
      } else {
        callback(null);
        return;
      }
    }
  }

  setMopMode(on, callback) {
    if (on) {
      if (this.mopMode) {
        callback(null);
        return;
      } else {
        this.setFanSpeed(ValetudoXiaomiVacuum.SPEEDS.mop, callback);
        return;
      }
    } else {
      if (this.mopMode) {
        this.setFanSpeed(this.powerControl.defaultSpeed, callback);
        return;
      } else {
        callback(null);
        return;
      }
    }
  }

  getBattery(callback) {
    this.getStatus(false, error => {
      if (error) {
        callback(error);
      } else {
        callback(null, this.current_status.battery);
      }
    });
  }

  getCharging(callback) {
    this.getStatus(false, error => {
      if (error) {
        callback(error);
      } else {
        if (
          this.current_status.state === ValetudoXiaomiVacuum.STATES.CHARGING
        ) {
          callback(null, Characteristic.ChargingState.CHARGING);
        } else if (
          this.current_status.state ===
            ValetudoXiaomiVacuum.STATES.CHARGER_DISCONNECTED ||
          this.current_status.state ===
            ValetudoXiaomiVacuum.STATES.CHARGING_PROBLEM
        ) {
          callback(null, Characteristic.ChargingState.NOT_CHARGEABLE);
        } else {
          callback(null, Characteristic.ChargingState.NOT_CHARGING);
        }
      }
    });
  }

  getBatteryLow(callback) {
    this.getStatus(false, error => {
      if (error) {
        callback(error);
      } else {
        if (this.current_status.battery < 20) {
          callback(null, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
        } else {
          callback(null, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        }
      }
    });
  }

  getServices() {
    return this.services;
  }

  getVersion(callback) {
    this.sendJSONRequest("http://" + this.ip + "/api/get_fw_version")
      .then(response => {
        callback(null, response.version);
      })
      .catch(e => {
        this.log.error(`Error parsing firmware info: ${e}`);
        callback(e);
      });
  }

  doFind(state, callback) {
    var log = this.log;

    if (state) {
      log.debug("Executing vacuum find");
      this.identify(() => {
        callback(null);
        setTimeout(() => {
          this.findService.updateCharacteristic(Characteristic.On, false);
        }, 250);
      });
    } else {
      callback(null);
    }
  }

  identify(callback) {
    this.sendJSONRequest("http://" + this.ip + "/api/find_robot", "PUT")
      .then(response => {
        callback();
      })
      .catch(e => {
        log.error(`Failed to identify robot: ${e}`);
        callback();
      });
  }

  goHome(state, callback) {
    var log = this.log;

    if (state) {
      log.debug("Executing go home");

      this.sendJSONRequest("http://" + this.ip + "/api/drive_home", "PUT")
        .then(response => {
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        })
        .catch(e => {
          log.error(`Failed to execute go home: ${e}`);
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        });
    } else {
      setTimeout(() => {
        callback();
        this.updateStatus(true);
      }, 3000);
    }
  }

  isGoingHome(callback) {
    var log = this.log;

    this.getStatus(false, error => {
      this.log.debug(
        `Is going home? error: ${error}, state: ${
          this.current_status !== null ? this.current_status.state : null
        }`
      );

      if (error) {
        return callback(
          new Error(`Error retrieving going home status: ${error}`)
        );
      }

      callback(
        null,
        this.current_status.state === ValetudoXiaomiVacuum.STATES.RETURNING_HOME
      );
    });
  }

  checkVolume(callback) {
    this.sendJSONRequest("http://" + this.ip + "/api/test_sound_volume", "PUT")
      .then(response => {
        callback();
      })
      .catch(e => {
        log.error(`Failed to test volume: ${e}`);
        callback();
      });
  }

  setVolume(value, callback) {
    var log = this.log;

    const volume = Math.max(1, value);

    log.debug(`Setting volume to ${volume}`);
    this.sendJSONRequest("http://" + this.ip + "/api/set_sound_volume", "PUT", {
      volume: volume
    })
      .then(response => {
        this.checkVolume(() => {
          callback();
        });
      })
      .catch(e => {
        log.error(`Failed to change volume: ${e}`);
        callback();
      });
  }

  updateVolume(callback) {
    this.getVolume((err, volume) => {
      if (err) {
        callback(err);
        return;
      }

      this.speakerService.updateCharacteristic(Characteristic.Volume, volume);
      callback();
    });
  }

  getVolume(callback) {
    var log = this.log;

    this.sendJSONRequest("http://" + this.ip + "/api/get_sound_volume", "GET")
      .then(response => {
        log.debug(`Got volume: ${response}`);
        callback(null, response);
      })
      .catch(e => {
        log.error(`Failed to get volume: ${e}`);
        callback(e);
      });
  }

  setMute(mute, callback) {
    var log = this.log;

    log.debug(`Setting mute to ${mute}`);

    const value = mute ? 1 : 100;

    this.setVolume(value, () => {
      this.updateVolume(() => {
        callback();
      });
    });
  }

  getMute(callback) {
    var log = this.log;

    this.sendJSONRequest("http://" + this.ip + "/api/get_sound_volume", "GET")
      .then(response => {
        log.debug(`Got volume for Mute: ${response.volume}`);
        callback(null, response.volume < 10 ? true : false);
      })
      .catch(e => {
        log.error(`Failed to get volume for Mute: ${e}`);
        callback(e);
      });
  }

  startCleaning(state, callback) {
    var log = this.log;

    if (state) {
      log.debug("Executing cleaning");

      this.sendJSONRequest("http://" + this.ip + "/api/start_cleaning", "PUT")
        .then(response => {
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        })
        .catch(e => {
          log.error(`Failed to execute start cleaning: ${e}`);
          setTimeout(() => {
            callback(e);
            this.updateStatus(true);
          }, 3000);
        });
    } else {
      this.getStatus(true, err => {
        if (err) {
          callback(err);
          return;
        }

        if (
          this.current_status.state === ValetudoXiaomiVacuum.STATES.CLEANING
        ) {
          this.stopCleaning(() => {
            callback();
          });
        } else {
          callback();
        }
      });
    }
  }

  stopCleaning(callback) {
    var log = this.log;

    log.debug("Executing stop cleaning");

    this.getStatus(true, err => {
      if (err) {
        callback(err);
        return;
      }

      if (
        this.current_status.state == ValetudoXiaomiVacuum.STATES.IDLE ||
        this.current_status.state ==
          ValetudoXiaomiVacuum.STATES.RETURNING_HOME ||
        this.current_status.state == ValetudoXiaomiVacuum.STATES.CHARGING ||
        this.current_status.state == ValetudoXiaomiVacuum.STATES.PAUSED ||
        this.current_status.state ==
          ValetudoXiaomiVacuum.STATES.SPOT_CLEANING ||
        this.current_status.state == ValetudoXiaomiVacuum.STATES.DOCKING ||
        this.current_status.state == ValetudoXiaomiVacuum.STATES.GOING_TO_TARGET
      ) {
        callback(new Error("Cannot stop cleaning in current state"));
      }

      this.sendJSONRequest("http://" + this.ip + "/api/stop_cleaning", "PUT")
        .then(response => {
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        })
        .catch(e => {
          this.log.error(`Failed to execute stop clean: ${e}`);
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        });
    });
  }

  isCleaning(callback) {
    this.getStatus(false, error => {
      this.log.debug(
        `Is cleaning? error: ${error}, state: ${
          this.current_status !== null ? this.current_status.state : null
        }`
      );

      if (error) {
        return callback(error);
      }

      callback(
        null,
        this.current_status.state === ValetudoXiaomiVacuum.STATES.CLEANING
      );
    });
  }

  startSpotCleaning(spot, state, callback) {
    var log = this.log;

    if (state) {
      log(`Executing spot cleaning ${spot}`);
      this.sendJSONRequest("http://" + this.ip + "/api/go_to", "PUT", {
        x: spot["x"],
        y: spot["y"]
      })
        .then(response => {
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        })
        .catch(e => {
          log.error(`Failed to execute start spot cleaning: ${e}`);
          setTimeout(() => {
            callback();
            this.updateStatus(true);
          }, 3000);
        });
    } else {
      callback(new Error("Cannot start spot cleaning"));
    }
  }

  isSpotCleaning(callback) {
    this.getStatus(false, error => {
      this.log.debug(
        `Is spot cleaning? error: ${error}, state: ${
          this.current_status !== null ? this.current_status.state : null
        }`
      );

      if (error) {
        return callback(error);
      }

      callback(
        null,
        this.current_status.state === ValetudoXiaomiVacuum.STATES.SPOT_CLEANING
      );
    });
  }

  updateStatus(forced = false) {
    this.log.debug("Updating vacuum status");
    this.getStatus(forced, err => {
      if (err) {
        return;
      }

      this.log.debug("Updating characteristics");

      this.batteryService.updateCharacteristic(
        Characteristic.BatteryLevel,
        this.current_status.battery
      );
      this.batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        this.current_status.battery < 20
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
      this.batteryService.updateCharacteristic(
        Characteristic.ChargingState,
        this.current_status.state == ValetudoXiaomiVacuum.STATES.CHARGING
          ? Characteristic.ChargingState.CHARGING
          : Characteristic.ChargingState.NOT_CHARGING
      );

      this.cleanService.updateCharacteristic(
        Characteristic.On,
        this.current_status.state == ValetudoXiaomiVacuum.STATES.CLEANING
      ); // cleaning
      this.goHomeService.updateCharacteristic(
        Characteristic.On,
        this.current_status.state == ValetudoXiaomiVacuum.STATES.RETURNING_HOME
      ); // driving home
      this.spotCleanService.updateCharacteristic(
        Characteristic.On,
        this.current_status.state == ValetudoXiaomiVacuum.STATES.SPOT_CLEANING
      ); // cleaning

      if (this.powerControl) {
        this.highSpeedMode =
          this.current_status["fan_power"] === this.powerControl.highSpeed;
        this.highSpeedService.updateCharacteristic(
          Characteristic.On,
          this.highSpeedMode
        );
        if (this.powerControl.mop) {
          this.mopMode =
            this.current_status["fan_power"] ===
            ValetudoXiaomiVacuum.SPEEDS.mop;
          this.mopService.updateCharacteristic(Characteristic.On, this.mopMode);
        }
      }
    });
  }

  updateInterval() {
    if (this.current_status !== null) {
      switch (this.current_status.state) {
        case ValetudoXiaomiVacuum.STATES.CHARGING:
        case ValetudoXiaomiVacuum.STATES.IDLE:
          return 120000; // slow update interval for idle states
        default:
          return 10000; // fast update interval for non-idle states
      }
    } else {
      return 10000;
    }
  }

  clearUpdateTimer() {
    clearTimeout(this.status_timer);
  }

  setupUpdateTimer() {
    this.status_timer = setTimeout(() => {
      this.updateStatus(true);
    }, this.updateInterval());
  }

  getStatus(forced, callback) {
    if (this.status_callbacks.length > 0) {
      this.log.debug("Pushing status callback to queue - updating");
      this.status_callbacks.push(callback);
      return;
    }

    const now = Date.now();

    if (
      !forced &&
      this.current_status !== null &&
      this.current_status_time !== null &&
      now - this.current_status_time < this.updateInterval()
    ) {
      this.log.debug("Returning cached status");
      callback(null);
      return;
    }

    this.clearUpdateTimer();

    this.log.debug(`Executing update, forced: ${forced}`);
    this.status_callbacks.push(callback);

    this.sendJSONRequest("http://" + this.ip + "/api/current_status")
      .then(response => {
        this.log.debug("Done executing update");
        this.current_status = response;
        this.current_status_time = Date.now();
        const callbacks = this.status_callbacks;
        this.status_callbacks = new Array();

        this.log.debug(`Calling ${callbacks.length} queued callbacks`);
        callbacks.forEach(element => {
          element(null, response);
        });
        this.setupUpdateTimer();
      })
      .catch(e => {
        this.log.error(`Error parsing current status info: ${e}`);
        const callbacks = this.status_callbacks;
        this.status_callbacks = new Array();

        callbacks.forEach(element => {
          element(e);
        });

        this.setupUpdateTimer();
      });
  }

  sendJSONRequest(url, method = "GET", payload = null) {
    return new Promise((resolve, reject) => {
      const components = new urllib.URL(url);

      const options = {
        method: method,
        host: components.hostname,
        port: components.port,
        path: components.pathname,
        protocol: components.protocol,
        headers: { "Content-Type": "application/json" }
      };

      const req = http.request(options, res => {
        res.setEncoding("utf8");

        let chunks = "";
        res.on("data", chunk => {
          chunks += chunk;
        });
        res.on("end", () => {
          try {
            this.log.debug(`Raw response: ${chunks}`);
            const parsed = JSON.parse(chunks);
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", err => {
        reject(err);
      });

      if (payload) {
        const stringified = JSON.stringify(payload);
        this.log(`sending payload: ${stringified}`);
        req.write(stringified);
      }

      req.end();
    });
  }

  getSpeedValue(preset) {
    switch (preset) {
      case "quiet":
        return ValetudoXiaomiVacuum.SPEEDS.quiet;
      case "balanced":
        return ValetudoXiaomiVacuum.SPEEDS.balanced;
      case "turbo":
        return ValetudoXiaomiVacuum.SPEEDS.turbo;
      case "max":
        return ValetudoXiaomiVacuum.SPEEDS.max;
      case "mop":
        return ValetudoXiaomiVacuum.SPEEDS.mop;
      default:
        throw Error(`Invalid power preset given: ${preset}`);
    }
  }
}

ValetudoXiaomiVacuum.STATES = {
  STARTING: 1,
  CHARGER_DISCONNECTED: 2,
  IDLE: 3,
  REMOTE_ACTIVE: 4,
  CLEANING: 5,
  RETURNING_HOME: 6,
  MANUAL_MODE: 7,
  CHARGING: 8,
  CHARGING_PROBLEM: 9,
  PAUSED: 10,
  SPOT_CLEANING: 11,
  ERROR: 12,
  SHUTTING_DOWN: 13,
  UPDATING: 14,
  DOCKING: 15,
  GOING_TO_TARGET: 16,
  ZONE_CLEANING: 17
};

ValetudoXiaomiVacuum.SPEEDS = {
  quiet: 101,
  balanced: 102,
  turbo: 103,
  max: 104,
  mop: 105
};
