
const session = require('express-session');
const Keycloak = require('keycloak-connect');

const memoryStore = new session.MemoryStore();

const keycloakConfig = {
  realm: process.env.KEYCLOAK_REALM,
  'auth-server-url': process.env.KEYCLOAK_SERVER_URL,
  'ssl-required': 'external',
  resource: process.env.KEYCLOAK_CLIENT_ID,
  'public-client': true,
  'confidential-port': 0
};

const keycloak = new Keycloak({ store: memoryStore }, keycloakConfig);
keycloak.logLevel = 'debug';

module.exports = {
  keycloak,
  memoryStore
};
