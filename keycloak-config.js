
const fs = require('fs');
const session = require('express-session');
const Keycloak = require('keycloak-connect');
const { config } = require('./config');

const memoryStore = new session.MemoryStore();

const keycloakConfig = {
  realm: config.KEYCLOAK_REALM,
  'auth-server-url': config.KEYCLOAK_SERVER_URL,
  'ssl-required': 'external',
  resource: config.KEYCLOAK_CLIENT_ID,
  'public-client': true,
  'confidential-port': 0
};

const keycloak = new Keycloak({ store: memoryStore }, keycloakConfig);
keycloak.logLevel = 'debug';

module.exports = {
  keycloak,
  memoryStore
};
