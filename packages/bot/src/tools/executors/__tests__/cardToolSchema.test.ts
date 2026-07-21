/**
 * Regression wall for the send_card tool schema (deterministic, no network).
 *
 * Guards the exact defect that recurred twice: the machine-readable schema handed
 * to the LLM degraded to a shape that only declares the `type` discriminator. Under
 * constrained decoding (Gemini) the decoder may then emit `{"type":"highlight"}` with
 * no content fields — grammatically valid against the advertised schema, but rejected
 * by parseCardDeck on every retry until tool rounds are exhausted and nothing is sent.
 *
 * A live LLM test with a permissive provider (deepseek/doubao) does NOT reproduce this —
 * those providers treat the schema as a hint and emit content anyway, so they pass on
 * both the broken and fixed schema. This static test IS the guard: it asserts every card
 * variant requires content beyond `type`, i.e. a constrained decoder is forced to emit it.
 */
import 'reflect-metadata';

// Import all executors to trigger @Tool() decorator registration.
import '@/tools/executors';

import { describe, expect, test } from 'bun:test';
import type { JsonSchemaNode } from '@/ai/types';
import { CARD_TYPES, isCardData } from '@/services/card/cardTypes';
import { ToolManager } from '@/tools/ToolManager';

/** The card-item schema exactly as it ships to the model (decorator → spec → tool definition). */
function getShippedCardItemsSchema(): JsonSchemaNode {
  const tm = new ToolManager();
  tm.autoRegisterTools();
  const spec = tm.getTool('send_card');
  if (!spec) {
    throw new Error('send_card tool is not registered — check @Tool() decorator and executor barrel import');
  }
  const [def] = tm.toToolDefinitions([spec]);
  const items = def.parameters.properties.cards?.items;
  if (!items) {
    throw new Error('send_card cards.items schema missing');
  }
  return items;
}

/** Single-value discriminator of a variant object schema (the `type` enum). */
function variantDiscriminator(variant: JsonSchemaNode): string {
  const typeProp = variant.properties?.type;
  expect(typeProp).toBeDefined();
  expect(Array.isArray(typeProp?.enum)).toBe(true);
  expect(typeProp?.enum?.length).toBe(1);
  return typeProp?.enum?.[0] as string;
}

/**
 * Build the smallest object a strict/constrained decoder could legally emit for a schema:
 * only its `required` fields, filled with placeholders. This mirrors what Gemini is allowed
 * to produce — if that minimal object doesn't satisfy the runtime validator, the schema lies.
 */
function buildMinimal(schema: JsonSchemaNode): unknown {
  if (schema.anyOf?.length) {
    return buildMinimal(schema.anyOf[0]);
  }
  if (schema.enum?.length) {
    return schema.enum[0];
  }
  switch (schema.type) {
    case 'string':
      return 'x';
    case 'boolean':
      return true;
    case 'number':
      return 1;
    case 'array':
      return schema.items ? [buildMinimal(schema.items)] : [];
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const propSchema = schema.properties?.[key];
        if (propSchema) {
          obj[key] = buildMinimal(propSchema);
        }
      }
      return obj;
    }
    default:
      return 'x';
  }
}

describe('send_card tool schema (regression wall)', () => {
  const itemsSchema = getShippedCardItemsSchema();

  test('cards.items is a discriminated anyOf union', () => {
    expect(Array.isArray(itemsSchema.anyOf)).toBe(true);
    expect(itemsSchema.anyOf?.length).toBeGreaterThan(0);
  });

  test('union covers exactly the CARD_TYPES discriminators', () => {
    const variants = itemsSchema.anyOf ?? [];
    const discriminators = variants.map(variantDiscriminator).sort();
    expect(discriminators).toEqual([...CARD_TYPES].sort());
  });

  test('every variant requires content beyond the `type` discriminator', () => {
    // THE core invariant: a variant that only requires `type` is the bug. Under
    // constrained decoding it lets the model emit a content-less `{"type":...}` card.
    for (const variant of itemsSchema.anyOf ?? []) {
      const type = variantDiscriminator(variant);
      const required = variant.required ?? [];
      expect(required).toContain('type');
      expect(required.length).toBeGreaterThan(1);
      // Every required field must actually be declared in properties.
      for (const field of required) {
        expect(variant.properties?.[field]).toBeDefined();
      }
      // A type-only object (worst case a strict decoder can emit) must be rejected.
      expect(isCardData({ type })).toBe(false);
    }
  });

  test('minimal decoder-legal object for each variant passes runtime validation', () => {
    // Binds schema ↔ validator: filling only the schema-required fields must produce
    // a card the type guards accept. Drift in either direction fails here.
    for (const variant of itemsSchema.anyOf ?? []) {
      const minimal = buildMinimal(variant);
      expect(isCardData(minimal)).toBe(true);
    }
  });
});
