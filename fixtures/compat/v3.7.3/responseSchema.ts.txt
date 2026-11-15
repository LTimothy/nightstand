// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/

import { z } from 'zod';

// Rebuild objects to strip unknown keys, so readers of responses and stored
// files tolerate newer data. Request validation keeps the strict originals.
// Reusing each definition preserves array limits and other existing constraints.
export function responseSchema<T extends z.ZodTypeAny>(schema: T): T {
  const definition = schema._def;
  switch (definition.typeName) {
  case z.ZodFirstPartyTypeKind.ZodObject:
    return new (schema.constructor as typeof z.ZodObject)({ ...definition, unknownKeys: 'strip', shape: () => Object.fromEntries(
      Object.entries((schema as unknown as z.AnyZodObject).shape)
        .map(([key, value]) => [key, responseSchema(value as z.ZodTypeAny)]),
    ) }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodArray:
    return new (schema.constructor as typeof z.ZodArray)({ ...definition, type: responseSchema(definition.type) }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodRecord:
    return new (schema.constructor as typeof z.ZodRecord)({ ...definition, valueType: responseSchema(definition.valueType) }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodUnion:
    return new (schema.constructor as typeof z.ZodUnion)({ ...definition, options: definition.options.map(responseSchema) }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
    return new (schema.constructor as typeof z.ZodDiscriminatedUnion)({ ...definition,
      options: definition.options.map(responseSchema),
      optionsMap: new Map([...definition.optionsMap].map(([key, value]) => [key, responseSchema(value)])),
    }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodEffects: {
    const effects = definition as z.ZodEffectsDef<z.ZodTypeAny>;
    return new (schema.constructor as typeof z.ZodEffects)({ ...effects, schema: responseSchema(effects.schema) }) as unknown as T;
  }
  case z.ZodFirstPartyTypeKind.ZodLazy: {
    const lazy = definition as z.ZodLazyDef<z.ZodTypeAny>;
    return new (schema.constructor as typeof z.ZodLazy)({ ...lazy, getter: () => responseSchema(lazy.getter()) }) as unknown as T;
  }
  case z.ZodFirstPartyTypeKind.ZodIntersection: {
    const intersection = definition as z.ZodIntersectionDef<z.ZodTypeAny, z.ZodTypeAny>;
    return new (schema.constructor as typeof z.ZodIntersection)({
      ...intersection, left: responseSchema(intersection.left), right: responseSchema(intersection.right),
    }) as unknown as T;
  }
  case z.ZodFirstPartyTypeKind.ZodPipeline: {
    const pipeline = definition as z.ZodPipelineDef<z.ZodTypeAny, z.ZodTypeAny>;
    return new (schema.constructor as typeof z.ZodPipeline)({
      ...pipeline, in: responseSchema(pipeline.in), out: responseSchema(pipeline.out),
    }) as unknown as T;
  }
  case z.ZodFirstPartyTypeKind.ZodReadonly: {
    const readonly = definition as z.ZodReadonlyDef<z.ZodTypeAny>;
    return new (schema.constructor as typeof z.ZodReadonly)({ ...readonly, innerType: responseSchema(readonly.innerType) }) as unknown as T;
  }
  case z.ZodFirstPartyTypeKind.ZodOptional:
    return new (schema.constructor as typeof z.ZodOptional)({
      ...definition, innerType: responseSchema(definition.innerType),
    }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodNullable:
    return new (schema.constructor as typeof z.ZodNullable)({
      ...definition, innerType: responseSchema(definition.innerType),
    }) as unknown as T;
  case z.ZodFirstPartyTypeKind.ZodDefault:
    return new (schema.constructor as typeof z.ZodDefault)({
      ...definition, innerType: responseSchema(definition.innerType),
    }) as unknown as T;
  default:
    return schema;
  }
}
