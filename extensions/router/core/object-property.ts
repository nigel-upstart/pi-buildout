/** Reads only a data property's own descriptor, without invoking accessors or reaching a prototype. */
export function ownProperty(source: object | undefined, key: PropertyKey): unknown {
  return source ? Object.getOwnPropertyDescriptor(source, key)?.value : undefined;
}
