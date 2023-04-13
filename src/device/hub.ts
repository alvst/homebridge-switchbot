import https from "https";
import crypto from "crypto";
import { Context } from "vm";
import { MqttClient } from "mqtt";
import { IncomingMessage } from "http";
import { interval, Subject } from "rxjs";
import { connectAsync } from "async-mqtt";
import superStringify from "super-stringify";
import { SwitchBotPlatform } from "../platform";
import { debounceTime, skipWhile, take, tap } from "rxjs/operators";
import { Service, PlatformAccessory, CharacteristicValue } from "homebridge";
import { device, devicesConfig, serviceData, switchbot, deviceStatus, ad, HostDomain, DevicePath } from "../settings";
import { sleep } from "../utils";

export class Hub {
  // Services
  hubTemperatureSensor: Service;
  hubHumiditySensor: Service;

  // Characteristic Values
  CurrentRelativeHumidity!: number;
  CurrentTemperature!: number;

  // OpenAPI Others
  deviceStatus!: any; //deviceStatusResponse;

  // Config
  set_minStep!: number;
  updateRate!: number;
  set_minLux!: number;
  set_maxLux!: number;
  scanDuration!: number;
  deviceLogging!: string;
  deviceRefreshRate!: number;
  setCloseMode!: string;
  setOpenMode!: string;

  // Updates
  curtainUpdateInProgress!: boolean;
  doCurtainUpdate!: Subject<void>;

  // Connection
  private readonly BLE = this.device.connectionType === "BLE" || this.device.connectionType === "BLE/OpenAPI";
  private readonly OpenAPI = this.device.connectionType === "OpenAPI" || this.device.connectionType === "BLE/OpenAPI";

  constructor(private readonly platform: SwitchBotPlatform, private accessory: PlatformAccessory, public device: device & devicesConfig) {
    // default placeholders
    this.logs(device);
    this.refreshRate(device);

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doCurtainUpdate = new Subject();
    this.curtainUpdateInProgress = false;
    console.log(accessory.context.model);
    console.log(accessory.context.CurrentRelativeHumidity);
    console.log(accessory);

    this.CurrentRelativeHumidity = accessory.context.CurrentRelativeHumidity;
    this.CurrentTemperature = accessory.context.CurrentTemperature;

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "SwitchBot")
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceId)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.FirmwareRevision(accessory, device))
      .getCharacteristic(this.platform.Characteristic.FirmwareRevision)
      .updateValue(this.FirmwareRevision(accessory, device));

    // get the WindowCovering service if it exists, otherwise create a new WindowCovering service
    // you can create multiple services for each accessory
    (this.hubTemperatureSensor =
      accessory.getService(this.platform.Service.TemperatureSensor) || accessory.addService(this.platform.Service.TemperatureSensor)),
      `${device.deviceName} ${device.deviceType}`;

    (this.hubHumiditySensor =
      accessory.getService(this.platform.Service.HumiditySensor) || accessory.addService(this.platform.Service.HumiditySensor)),
      `${device.deviceName} ${device.deviceType}`;

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // accessory.getService('NAME') ?? accessory.addService(this.platform.Service.WindowCovering, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.hubTemperatureSensor.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    if (!this.hubTemperatureSensor.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      this.hubTemperatureSensor.addCharacteristic(this.platform.Characteristic.ConfiguredName, accessory.displayName);
    }

    this.hubHumiditySensor.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    if (!this.hubHumiditySensor.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      this.hubHumiditySensor.addCharacteristic(this.platform.Characteristic.ConfiguredName, accessory.displayName);
    }

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/WindowCovering

    // create handlers for required characteristics
    this.hubTemperatureSensor.setCharacteristic(this.platform.Characteristic.CurrentTemperature, this.CurrentTemperature);
    this.hubHumiditySensor.setCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.CurrentRelativeHumidity);

    // Update Homekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.deviceRefreshRate * 1000)
      .pipe(skipWhile(() => this.curtainUpdateInProgress))
      .subscribe(async () => {
        console.log("refresh");
        await this.refreshStatus();
      });
  }

  /**
   * Parse the device status from the SwitchBot api
   */
  async parseStatus(): Promise<void> {
    // if (!this.device.enableCloudService && this.OpenAPI) {
    //   this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} parseStatus enableCloudService: ${this.device.enableCloudService}`);
    // } else
    console.log("this.parseStatus");
    if (this.OpenAPI && this.platform.config.credentials?.token) {
      await this.openAPIparseStatus();
    } else {
      await this.offlineOff();
      this.debugWarnLog(
        `${this.device.deviceType}: ${this.accessory.displayName} Connection Type:` + ` ${this.device.connectionType}, parseStatus will not happen.`,
      );
    }
  }

  async openAPIparseStatus(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} openAPIparseStatus`);
    console.log(`update temperature and humidity for ${this.accessory.displayName}`);
    console.log(`temp: ${this.CurrentTemperature}, humidity: ${this.CurrentRelativeHumidity}`);
    this.hubTemperatureSensor.setCharacteristic(this.platform.Characteristic.CurrentTemperature, this.CurrentTemperature);
    this.hubHumiditySensor.setCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.CurrentRelativeHumidity);
    // CurrentPosition
    console.log("Todo: openAPIparseStatus");
  }

  async refreshStatus(): Promise<void> {
    console.log("refreshing status");
    if (this.OpenAPI && this.platform.config.credentials?.token) {
      console.log("refreshing status 2");
      await this.openAPIRefreshStatus();
    } else {
      await this.offlineOff();
      this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} Connection Type: OpenAPI, refreshStatus will not happen.`);
    }
  }

  async openAPIRefreshStatus(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} openAPIRefreshStatus`);
    try {
      const t = Date.now();
      const nonce = "requestID";
      const data = this.platform.config.credentials?.token + t + nonce;
      const signTerm = crypto.createHmac("sha256", this.platform.config.credentials?.secret).update(Buffer.from(data, "utf-8")).digest();
      const sign = signTerm.toString("base64");
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} sign: ${sign}`);
      const options = {
        hostname: HostDomain,
        port: 443,
        path: `${DevicePath}/${this.device.deviceId}/status`,
        method: "GET",
        headers: {
          Authorization: this.platform.config.credentials?.token,
          sign: sign,
          nonce: nonce,
          t: t,
          "Content-Type": "application/json",
        },
      };
      const req = https.request(options, (res) => {
        this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} statusCode: ${res.statusCode}`);
        this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName}: ${res}`);
        let rawData = "";
        res.on("data", (d) => {
          rawData += d;
          this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} d: ${d}`);
        });
        res.on("end", () => {
          try {
            this.deviceStatus = JSON.parse(rawData);
            this.CurrentTemperature = this.deviceStatus.body.temperature;
            this.CurrentRelativeHumidity = this.deviceStatus.body.humidity;
            console.log("this.deviceStatus");
            console.log(this.deviceStatus);
            console.log(`${this.device.deviceType}: ${this.accessory.displayName} refreshStatus: ${superStringify(this.deviceStatus)}`);
            this.openAPIparseStatus();
            this.updateHomeKitCharacteristics();
          } catch (e: any) {
            this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} error message: ${e.message}`);
          }
        });
      });
      req.on("error", (e: any) => {
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} error message: ${e.message}`);
      });
      req.end();
    } catch (e: any) {
      this.apiError(e);
      this.errorLog(
        `${this.device.deviceType}: ${this.accessory.displayName} failed openAPIRefreshStatus with ${this.device.connectionType}` +
          ` Connection, Error Message: ${superStringify(e.message)}`,
      );
    }
  }

  async retry({ max, fn }: { max: number; fn: { (): any; (): Promise<any> } }): Promise<null> {
    return fn().catch(async (e: any) => {
      if (max === 0) {
        throw e;
      }
      this.infoLog(e);
      this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Retrying`);
      await sleep(1000);
      return this.retry({ max: max - 1, fn });
    });
  }

  maxRetry(): number {
    if (this.device.maxRetry) {
      return this.device.maxRetry;
    } else {
      return 5;
    }
  }

  /**
   * Handle requests to set the value of the "Target Position" characteristic
   */

  async updateHomeKitCharacteristics(): Promise<void> {
    console.log("Todo: updateHomeKitCharacteristics");

    this.hubHumiditySensor?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.CurrentRelativeHumidity);
    console.log(this.CurrentRelativeHumidity);
    this.hubTemperatureSensor?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.CurrentTemperature);
  }

  async statusCode({ res }: { res: IncomingMessage }): Promise<void> {
    switch (res.statusCode) {
      case 151:
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} Command not supported by this device type.`);
        break;
      case 152:
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} Device not found.`);
        break;
      case 160:
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} Command is not supported.`);
        break;
      case 161:
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} Device is offline.`);
        this.offlineOff();
        break;
      case 171:
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} Hub Device is offline. Hub: ${this.device.hubDeviceId}`);
        this.offlineOff();
        break;
      case 190:
        this.errorLog(
          `${this.device.deviceType}: ${this.accessory.displayName} Device internal error due to device states not synchronized with server,` +
            ` Or command: ${superStringify(res)} format is invalid`,
        );
        break;
      case 100:
        this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Command successfully sent.`);
        break;
      default:
        this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Unknown statusCode.`);
    }
  }

  async offlineOff(): Promise<void> {
    if (this.device.offline) {
      await this.updateHomeKitCharacteristics();
    }
  }

  async apiError(e: any): Promise<void> {
    // this.CurrentTemperature.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, e);
    // this.CurrentRelativeHumidity.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, e);
  }

  FirmwareRevision(accessory: PlatformAccessory<Context>, device: device & devicesConfig): CharacteristicValue {
    let FirmwareRevision: string;
    this.debugLog(
      `${this.device.deviceType}: ${this.accessory.displayName}` + ` accessory.context.FirmwareRevision: ${accessory.context.FirmwareRevision}`,
    );
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} device.firmware: ${device.firmware}`);
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} this.platform.version: ${this.platform.version}`);
    if (accessory.context.FirmwareRevision) {
      FirmwareRevision = accessory.context.FirmwareRevision;
    } else if (device.firmware) {
      FirmwareRevision = device.firmware;
    } else {
      FirmwareRevision = this.platform.version;
    }
    return FirmwareRevision;
  }

  async refreshRate(device: device & devicesConfig): Promise<void> {
    // refreshRate
    if (device.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = device.refreshRate;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Device Config refreshRate: ${this.deviceRefreshRate}`);
    } else if (this.platform.config.options!.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = this.platform.config.options!.refreshRate;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Platform Config refreshRate: ${this.deviceRefreshRate}`);
    }
    // updateRate
    if (device?.curtain?.updateRate) {
      this.updateRate = device?.curtain?.updateRate;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Device Config Curtain updateRate: ${this.updateRate}`);
    } else {
      this.updateRate = 7;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Default Curtain updateRate: ${this.updateRate}`);
    }
  }

  //   async config(device: device & devicesConfig): Promise<void> {
  //     let config = {};
  //     if (device.curtain) {
  //       config = device.curtain;
  //     }
  //     if (device.connectionType !== undefined) {
  //       config["connectionType"] = device.connectionType;
  //     }
  //     if (device.external !== undefined) {
  //       config["external"] = device.external;
  //     }
  //     if (device.mqttURL !== undefined) {
  //       config["mqttURL"] = device.mqttURL;
  //     }
  //     if (device.logging !== undefined) {
  //       config["logging"] = device.logging;
  //     }
  //     if (device.refreshRate !== undefined) {
  //       config["refreshRate"] = device.refreshRate;
  //     }
  //     if (device.scanDuration !== undefined) {
  //       config["scanDuration"] = device.scanDuration;
  //     }
  //     if (device.maxRetry !== undefined) {
  //       config["maxRetry"] = device.maxRetry;
  //     }
  //     if (Object.entries(config).length !== 0) {
  //       this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Config: ${superStringify(config)}`);
  //     }
  //   }

  // !! Do not change below
  async logs(device: device & devicesConfig): Promise<void> {
    if (this.platform.debugMode) {
      this.deviceLogging = this.accessory.context.logging = "debugMode";
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Debug Mode Logging: ${this.deviceLogging}`);
    } else if (device.logging) {
      this.deviceLogging = this.accessory.context.logging = device.logging;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Device Config Logging: ${this.deviceLogging}`);
    } else if (this.platform.config.options?.logging) {
      this.deviceLogging = this.accessory.context.logging = this.platform.config.options?.logging;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Using Platform Config Logging: ${this.deviceLogging}`);
    } else {
      this.deviceLogging = this.accessory.context.logging = "standard";
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Logging Not Set, Using: ${this.deviceLogging}`);
    }
  }

  /**
   * Logging for Device
   */
  infoLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.info(String(...log));
    }
  }

  warnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.warn(String(...log));
    }
  }

  debugWarnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging?.includes("debug")) {
        this.platform.log.warn("[DEBUG]", String(...log));
      }
    }
  }

  errorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.error(String(...log));
    }
  }

  debugErrorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging?.includes("debug")) {
        this.platform.log.error("[DEBUG]", String(...log));
      }
    }
  }

  debugLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging === "debug") {
        this.platform.log.info("[DEBUG]", String(...log));
      } else {
        this.platform.log.debug(String(...log));
      }
    }
  }

  enablingDeviceLogging(): boolean {
    return this.deviceLogging.includes("debug") || this.deviceLogging === "standard";
  }
}
