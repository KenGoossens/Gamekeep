import type { PortForwardRule, RequiredForward } from '../unifi.js';

/**
 * What the portal needs from a router, and nothing more.
 *
 * Port forwarding is the one thing that cannot be done from inside a
 * container, and every household has a different box doing it. Rather than
 * assume UniFi, the portal talks to this interface; UniFi is simply the first
 * implementation. With no provider configured the portal still works and
 * explains what to do by hand.
 */
export interface RouterProvider {
  readonly id: string;
  readonly label: string;
  /** Proves the connection and returns anything worth showing the operator. */
  test(): Promise<{ rules: number; detail: string; fingerprint?: string | null }>;
  list(): Promise<PortForwardRule[]>;
  create(target: string, required: RequiredForward): Promise<PortForwardRule>;
  remove(id: string): Promise<void>;
}

export interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  /** Fields the operator fills in to connect this kind of router. */
  fields: ProviderField[];
  create(config: Record<string, string>): RouterProvider;
}

const registry = new Map<string, ProviderDefinition>();

export function registerProvider(definition: ProviderDefinition): void {
  registry.set(definition.id, definition);
}

export function listProviders(): Array<{ id: string; label: string; fields: ProviderField[] }> {
  return [...registry.values()].map((d) => ({ id: d.id, label: d.label, fields: d.fields }));
}

export function buildProvider(id: string, config: Record<string, string>): RouterProvider | null {
  const definition = registry.get(id);
  return definition ? definition.create(config) : null;
}
