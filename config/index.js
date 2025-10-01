// config.js
const { WorkloadIdentityCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const keyVaultName = "itc-kv"; 
const keyVaultUrl = `https://${keyVaultName}.vault.azure.net`;

const credential = new WorkloadIdentityCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

const secretNames = [
  "DB-HOST", "DB-PORT", "DB-USER", "DB-PASSWORD", "DB-NAME",
  "DB-POOL-MAX", "DB-POOL-IDLE-TIMEOUT", "KEYCLOAK-REALM",
  "KEYCLOAK-CLIENT-ID", "KEYCLOAK-SERVER-URL", "KEYCLOAK-PUBLIC-KEY",
  "KEYCLOAK-ADMIN-CLIENT-ID", "KEYCLOAK-ADMIN-CLIENT-SECRET",
  "SMTP-HOST", "SMTP-PORT", "SMTP-USER", "SMTP-PASS", "SMTP-FROM-EMAIL",
  "PORT"
];

const config = {};

async function loadConfig() {
  try {
    console.log(`Loading configuration from Azure Key Vault: ${keyVaultUrl}`);
    for (const name of secretNames) {
      const secret = await secretClient.getSecret(name);
      const envVarName = name.replace(/-/g, '_');
      config[envVarName] = secret.value;
    }
    console.log("Configuration loaded successfully.");
    return config;
  } catch (error) {
    console.error("Failed to load configuration from Azure Key Vault", error);
    process.exit(1);
  }
}

module.exports = { config, loadConfig };
