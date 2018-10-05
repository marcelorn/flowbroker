var axios = require("axios");
var util = require('util');
var kafka = require('./kafka');
var amqp = require('./amqp');
var config = require('./config');
var node = require('./nodeManager').Manager;
var redisManager = require('./redisManager').RedisManager;


// class InitializationError extends Error {}

module.exports = class DeviceIngestor {
  /**
   * Constructor.
   * @param {FlowManagerBuilder} fmBuilder Builder instance to be used when parsing received events
   */
  constructor(fmBuilder) {
    // using redis as cache
    this.redis = new redisManager();
    this.client = this.redis.getClient();
    // map of active consumers (used to detect topic rebalancing by kafka)
    this.consumers = {};
    this.fmBuiler = fmBuilder;
    this.amqp = new amqp.AMQPProducer(config.amqp.queue, config.amqp.url, 2);
  }

  /**
   * Lists current known tenants in the platform
   * @return {[Promise]}  List of known tenants in the platform
   */
  listTenants() {
    let url = config.tenancy.manager + '/admin/tenants';
    return axios({ url }).then((response) => response.data.tenants);
  }

  /**
   * Initialize iotagent kafka consumers (for tenant and device events)
   * @return {Promise}
   */
  initConsumer() {
    let consumer = new kafka.Consumer('internal', config.tenancy.subject, true);

    consumer.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.value.toString());
      } catch (e) {
        console.error('Received tenancy event is not valid json. Ignoring.');
        return;
      }

      this.bootstrapTenant(parsed.tenant);
    });

    consumer.on('connect', () => {
      this.initTenants();
    });

    return this.amqp.connect();
  }

  initTenants() {
    if (!this.consumers.hasOwnProperty('tenancy')) {
      // console.log('got connect event - tenancy');
      this.listTenants().then((tenants) => {
        for (let t of tenants) {
          this.bootstrapTenant(t);
        }
        console.log('[ingestor] Tenancy context management initialized');
        this.consumers.tenancy = true;
      }).catch((error) => {
        const message = "Failed to acquire existing tenancy contexts";
        console.error("[ingestor] %s - %s", message, error.message);
        setTimeout(() => { this.initTenants(); }, 2000);
        // throw new InitializationError(message);
      });
    }
  }

  /**
   * Given a tenant, initialize the related device event stream ingestor.
   *
   * @param  {[string]} tenant tenant which ingestion stream is to be initialized
   */
  bootstrapTenant(tenant) {
    node.addTenant(tenant);
    const consumerid = tenant + ".device";
    if (this.consumers.hasOwnProperty(consumerid)) {
      console.log('[ingestor] Attempted to re-init device consumer for tenant:', tenant);
      return;
    }

    let consumer = new kafka.Consumer(tenant, config.ingestion.subject);
    let consumerDevices = new kafka.Consumer(tenant, config.ingestion.devices);
    this.consumers[consumerid] = true;

    consumerDevices.on('connect', () => {
      console.log(`[ingestor] Device info consumer ready for tenant ${tenant}`);
    });

    consumer.on('connect', () => {
      console.log(`[ingestor] Device consumer ready for tenant: ${tenant}`);
    });

    consumer.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.value.toString());
      } catch (e) {
        console.error("[ingestor] Device event is not valid json. Ignoring.");
        return;
      }

      try {
        this.handleEvent(parsed);
      } catch (error) {
        console.error('[ingestor] Device event ingestion failed: ', error.message);
      }
    });

    consumerDevices.on('message', (data) => {
      try {
        const message = JSON.parse(data.value.toString());
        if (message.event === 'update' || message.event === 'remove') {
          this.handleUpdate(message.meta.service, message.data.id);
        }
        if (message.event === 'template.update') {
          message.data.affected.forEach(deviceid => {
            this.handleUpdate(message.meta.service, deviceid);
          })
        }
      } catch (error) {
        console.error(`[ingestor] Device-manager event ingestion failed: `, error.message);
      }
    });

    consumer.on('error', (error) => {
      console.error('[ingestor:kafka] Consumer for tenant "%s" is errored.', tenant);
      console.error('[ingestor:kafka] Error is: %s', error);
    });

    consumerDevice.on('error', (error) => {
      console.error('[ingestor:kafka] Consumer device for tenant "%s" is errored.', tenant);
      console.error('[ingestor:kafka] Error is: %s', error);
    })
  }

  _publish(node, message, flow, metadata) {
    if (node.hasOwnProperty('status') &&
      (node.status.toLowerCase() !== 'true') &&
      metadata.hasOwnProperty('reason') &&
      (metadata.reason === 'statusUpdate')) {
      console.log(`[ingestor] ignoring device status update ${metadata.deviceid} ${flow.id}`);
      return;
    }

    // new events must have the lowest priority in the queue, in this way
    // events that are being processed can be finished first
    // This should work for single output nodes only!
    for (let output of node.wires) {
      for (let hop of output) {
        this.amqp.sendMessage(JSON.stringify({
          hop: hop,
          message: message,
          flow: flow,
          metadata: {
            tenant: metadata.tenant,
            originator: metadata.deviceid
          }
        }), 0);
      }
    }
  }

  handleFlow(event, flow, isTemplate) {
    flow.nodeMap = {};
    for (let node of flow.red) {
      flow.nodeMap[node.id] = node;
    }

    for (let head of flow.heads) {
      const node = flow.nodeMap[head];
      // handle input by device
      if (node.hasOwnProperty('_device_id') &&
        (node._device_id === event.metadata.deviceid) &&
        (isTemplate === false)) {
        this._publish(node, { payload: event.attrs }, flow, event.metadata);
      }

      // handle input by template
      if (node.hasOwnProperty('device_template_id') &&
        event.metadata.hasOwnProperty('templates') &&
        (event.metadata.templates.includes(node.device_template_id)) &&
        (isTemplate === true)) {
        this._publish(node, { payload: event.attrs }, flow, event.metadata);
      }
    }
  }

  handleEvent(event) {
    console.log(`[ingestor] got new device event: ${util.inspect(event, { depth: null })}`);
    let flowManager = this.fmBuiler.get(event.metadata.tenant);
    flowManager.getByDevice(event.metadata.deviceid).then((flowlist) => {
      for (let flow of flowlist) {
        this.handleFlow(event, flow, false);
      }
    });

    this.client.getDeviceInfo(event.metadata.tenant, event.metadata.deviceid, this.redis.getState()).then((data) => {

      event.metadata.templates = data.templates;

      if (data.staticAttrs !== null) {
        if (event.metadata.hasOwnProperty('reason')) {
          if (event.metadata.reason === 'statusUpdate') {
            event.attrs = {};
          }
        }
        // Copy static attrs to event.attrs
        for (var attr in data.staticAttrs) {
          event.attrs[attr] = data.staticAttrs[attr];
        }
      }

      for (let template of data.templates) {
        flowManager.getByTemplate(template).then( (flowlist) => {
          for (let flow of flowlist) {
            this.handleFlow(event, flow, true);
          }
        });
      }
    }).catch((error) => {
      console.log(error);
    })
  }

  handleUpdate(tenant, deviceid) {
    this.client.deleteDevice(tenant, deviceid);
  }
};