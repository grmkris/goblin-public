export type JsonObject = { readonly [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
