"use strict";
// Hand-written validator for the subset of JSON Schema used in schema/tools.json.
// Mirrors common/zbcore.py:validate. Patterns must be fully anchored (^...$).

function zbTypeOk(t, v) {
  switch (t) {
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
  }
  return false;
}

function zbValidate(schema, v, path = "$") {
  const t = schema.type;
  if (t && !zbTypeOk(t, v)) return `${path}: expected ${t}`;
  if (schema.enum && !schema.enum.includes(v)) return `${path}: not an allowed value`;
  if (typeof v === "string") {
    if (v.length < (schema.minLength ?? 0)) return `${path}: too short`;
    if (v.length > (schema.maxLength ?? Infinity)) return `${path}: too long`;
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${path}: bad format`;
  }
  if (t === "integer" || t === "number") {
    if (v < (schema.minimum ?? -Infinity) || v > (schema.maximum ?? Infinity)) return `${path}: out of range`;
  }
  if (t === "array") {
    if (v.length > (schema.maxItems ?? Infinity)) return `${path}: too many items`;
    if (v.length < (schema.minItems ?? 0)) return `${path}: too few items`;
    for (let i = 0; i < v.length; i++) {
      const e = zbValidate(schema.items || {}, v[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (t === "object") {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!Object.hasOwn(v, k)) return `${path}: missing ${k}`;
    for (const k of Object.keys(v)) {
      if (!Object.hasOwn(props, k)) {
        if (schema.additionalProperties === false) return `${path}: unknown field ${k.slice(0, 40)}`;
        continue;
      }
      const e = zbValidate(props[k], v[k], `${path}.${k}`);
      if (e) return e;
    }
    const groups = schema["x-oneOfGroups"];
    for (const g of Array.isArray(groups) ? groups : groups ? [groups] : []) {
      const touched = g.groups.filter((grp) => grp.some((k) => Object.hasOwn(v, k)));
      if (touched.length > 1 || (touched.length === 0 && !g.optional)) {
        return `${path}: give ${g.optional ? "at most" : "exactly"} one of ` + g.groups.map((x) => x.join("+")).join(" | ");
      }
      if (touched.length && g.complete && !touched[0].every((k) => Object.hasOwn(v, k))) return `${path}: need all of ` + touched[0].join("+");
    }
  }
  return null;
}

function zbValidateRequest(schema, msg) {
  return zbValidate(schema.envelope.request, msg) ||
    zbValidate(schema.tools[msg.tool].args, msg.args, "$.args");
}

function zbValidateResult(schema, tool, result) {
  return zbValidate(schema.tools[tool].result, result, "$.result");
}

if (typeof module !== "undefined") module.exports = { zbValidate, zbValidateRequest, zbValidateResult };
