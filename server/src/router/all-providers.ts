/**
 * Every router the portal can talk to, registered by importing. One import
 * of this file is what "the dropdown shows all vendors" means; forgetting a
 * provider here is forgetting it exists.
 */
import './unifi-provider.js';
import './fritz-provider.js';
import './upnp-provider.js';
import './mikrotik-provider.js';
