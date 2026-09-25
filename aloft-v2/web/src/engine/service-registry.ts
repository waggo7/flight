// Typed service lookup. A feature that owns something (the flight model, the scene) provides it
// under a token; other features require it by the same token. No central god object.

export interface ServiceToken<T> {
  readonly name: string;
  /** Phantom field that carries the type; never set. */
  readonly __type?: T;
}

export const serviceToken = <T>(name: string): ServiceToken<T> => ({ name });

export class ServiceRegistry {
  private readonly services = new Map<ServiceToken<unknown>, unknown>();

  provide<T>(token: ServiceToken<T>, value: T): T {
    if (this.services.has(token)) throw new Error(`Service "${token.name}" is already provided.`);
    this.services.set(token, value);
    return value;
  }

  require<T>(token: ServiceToken<T>): T {
    if (!this.services.has(token)) throw new Error(`Service "${token.name}" is not provided. Check the feature order in app/feature-list.ts.`);
    return this.services.get(token) as T;
  }

  optional<T>(token: ServiceToken<T>): T | undefined {
    return this.services.get(token) as T | undefined;
  }
}
