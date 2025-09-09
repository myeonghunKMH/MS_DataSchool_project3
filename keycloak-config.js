
const fs = require('fs');
const session = require('express-session');
const Keycloak = require('keycloak-connect');

const memoryStore = new session.MemoryStore();

const keycloakConfig = {
  realm: fs.readFileSync('/etc/secrets/KEYCLOAK_REALM', 'utf8'),
  'auth-server-url': fs.readFileSync('/etc/secrets/KEYCLOAK_SERVER_URL', 'utf8'),
  'ssl-required': 'external',
  resource: fs.readFileSync('/etc/secrets/KEYCLOAK_CLIENT_ID', 'utf8'),
  'public-client': true,
  'confidential-port': 0
};

const keycloak = new Keycloak({ store: memoryStore }, keycloakConfig);
keycloak.logLevel = 'debug';

module.exports = {
  keycloak,
  memoryStore
};
