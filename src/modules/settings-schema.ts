/**
 * P2 Claw — Module settings schema validator.
 *
 * Validates settings field descriptors from manifest.json at load time and
 * validates submitted values at write time. Core owns all validation;
 * modules declare schemas, Core enforces them.
 *
 * Part H — Module Settings And HTML Contribution Hooks.
 */

import type { SettingFieldDescriptor, SettingFieldType } from "./types.js";
import { ManifestValidationError } from "./manifest.js";

/** Maximum number of settings fields per module. */
export const MAX_SETTINGS_FIELDS = 30;

/** Maximum length of a setting key. */
const MAX_KEY_LENGTH = 64;

/** Maximum length of a string setting value. */
const MAX_STRING_VALUE_LENGTH = 4096;

/** Maximum number of options in a select field. */
const MAX_SELECT_OPTIONS = 50;

const KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const VALID_TYPES: readonly SettingFieldType[] = ["string", "number", "boolean", "select"];

/**
 * Validates an array of settings field descriptors from a module manifest.
 * Throws ManifestValidationError on any invalid shape.
 */
export function validateSettingsSchema(
  raw: unknown,
  moduleId: string
): SettingFieldDescriptor[] {
  if (!Array.isArray(raw)) {
    throw new ManifestValidationError(
      "ERR_SETTINGS_SCHEMA",
      `module "${moduleId}" manifest.settings must be an array`
    );
  }

  if (raw.length > MAX_SETTINGS_FIELDS) {
    throw new ManifestValidationError(
      "ERR_SETTINGS_SCHEMA",
      `module "${moduleId}" manifest.settings exceeds ${MAX_SETTINGS_FIELDS} fields`
    );
  }

  const keys = new Set<string>();
  const fields: SettingFieldDescriptor[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown>;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" manifest.settings[${i}] must be an object`
      );
    }

    // key
    const key = entry.key;
    if (typeof key !== "string" || !KEY_REGEX.test(key)) {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings[${i}].key must match ${KEY_REGEX} (got "${String(key)}")`
      );
    }
    if (keys.has(key)) {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings has duplicate key "${key}"`
      );
    }
    keys.add(key);

    // type
    const type = entry.type;
    if (typeof type !== "string" || !(VALID_TYPES as readonly string[]).includes(type)) {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings["${key}"].type must be one of: ${VALID_TYPES.join(", ")}`
      );
    }

    // label
    if (typeof entry.label !== "string" || entry.label.trim().length === 0) {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings["${key}"].label must be a non-empty string`
      );
    }

    // description
    if (typeof entry.description !== "string") {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings["${key}"].description must be a string`
      );
    }

    // required
    if (typeof entry.required !== "boolean") {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings["${key}"].required must be a boolean`
      );
    }

    // sensitive
    if (typeof entry.sensitive !== "boolean") {
      throw new ManifestValidationError(
        "ERR_SETTINGS_SCHEMA",
        `module "${moduleId}" settings["${key}"].sensitive must be a boolean`
      );
    }

    // default — validate type match
    const dflt = entry.default;
    validateDefaultForType(type as SettingFieldType, dflt, moduleId, key);

    // type-specific constraints
    const field: SettingFieldDescriptor = {
      key,
      type: type as SettingFieldType,
      label: (entry.label as string).trim(),
      description: entry.description as string,
      required: entry.required as boolean,
      sensitive: entry.sensitive as boolean,
      default: dflt as string | number | boolean,
    };

    if (type === "number") {
      if (entry.min !== undefined) {
        if (typeof entry.min !== "number" || !Number.isFinite(entry.min)) {
          throw new ManifestValidationError(
            "ERR_SETTINGS_SCHEMA",
            `module "${moduleId}" settings["${key}"].min must be a finite number`
          );
        }
        field.min = entry.min;
      }
      if (entry.max !== undefined) {
        if (typeof entry.max !== "number" || !Number.isFinite(entry.max)) {
          throw new ManifestValidationError(
            "ERR_SETTINGS_SCHEMA",
            `module "${moduleId}" settings["${key}"].max must be a finite number`
          );
        }
        field.max = entry.max;
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"].min (${field.min}) > max (${field.max})`
        );
      }
    }

    if (type === "string") {
      if (entry.pattern !== undefined) {
        if (typeof entry.pattern !== "string") {
          throw new ManifestValidationError(
            "ERR_SETTINGS_SCHEMA",
            `module "${moduleId}" settings["${key}"].pattern must be a string`
          );
        }
        // Validate that the pattern is a valid regex
        try {
          new RegExp(entry.pattern);
        } catch {
          throw new ManifestValidationError(
            "ERR_SETTINGS_SCHEMA",
            `module "${moduleId}" settings["${key}"].pattern is not a valid regex`
          );
        }
        field.pattern = entry.pattern;
      }
      if (entry.maxLength !== undefined) {
        if (
          typeof entry.maxLength !== "number" ||
          !Number.isFinite(entry.maxLength) ||
          entry.maxLength < 1 ||
          entry.maxLength > MAX_STRING_VALUE_LENGTH
        ) {
          throw new ManifestValidationError(
            "ERR_SETTINGS_SCHEMA",
            `module "${moduleId}" settings["${key}"].maxLength must be 1–${MAX_STRING_VALUE_LENGTH}`
          );
        }
        field.maxLength = Math.floor(entry.maxLength);
      }
    }

    if (type === "select") {
      if (!Array.isArray(entry.options) || entry.options.length === 0) {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"] type "select" requires a non-empty "options" array`
        );
      }
      if (entry.options.length > MAX_SELECT_OPTIONS) {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"].options exceeds ${MAX_SELECT_OPTIONS} entries`
        );
      }
      for (const opt of entry.options) {
        if (typeof opt !== "string") {
          throw new ManifestValidationError(
            "ERR_SETTINGS_SCHEMA",
            `module "${moduleId}" settings["${key}"].options entries must be strings`
          );
        }
      }
      field.options = entry.options as string[];

      // Validate default is one of the options
      if (typeof dflt === "string" && !(entry.options as string[]).includes(dflt)) {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"].default "${dflt}" is not in options`
        );
      }
    }

    fields.push(field);
  }

  return fields;
}

function validateDefaultForType(
  type: SettingFieldType,
  dflt: unknown,
  moduleId: string,
  key: string
): void {
  switch (type) {
    case "string":
    case "select":
      if (typeof dflt !== "string") {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"].default must be a string for type "${type}"`
        );
      }
      break;
    case "number":
      if (typeof dflt !== "number" || !Number.isFinite(dflt)) {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"].default must be a finite number for type "number"`
        );
      }
      break;
    case "boolean":
      if (typeof dflt !== "boolean") {
        throw new ManifestValidationError(
          "ERR_SETTINGS_SCHEMA",
          `module "${moduleId}" settings["${key}"].default must be a boolean for type "boolean"`
        );
      }
      break;
  }
}

/**
 * Validates a submitted settings value against its field descriptor.
 * Returns `{ ok: true }` or `{ ok: false, error: string }`.
 */
export function validateSettingValue(
  field: SettingFieldDescriptor,
  value: unknown
): { ok: true } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    if (field.required) {
      return { ok: false, error: `"${field.key}" is required` };
    }
    return { ok: true };
  }

  switch (field.type) {
    case "string": {
      if (typeof value !== "string") {
        return { ok: false, error: `"${field.key}" must be a string` };
      }
      if (field.required && value.trim().length === 0) {
        return { ok: false, error: `"${field.key}" is required` };
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return { ok: false, error: `"${field.key}" exceeds max length ${field.maxLength}` };
      }
      if (value.length > MAX_STRING_VALUE_LENGTH) {
        return { ok: false, error: `"${field.key}" exceeds max length ${MAX_STRING_VALUE_LENGTH}` };
      }
      if (field.pattern !== undefined) {
        const re = new RegExp(field.pattern);
        if (!re.test(value)) {
          return { ok: false, error: `"${field.key}" does not match pattern ${field.pattern}` };
        }
      }
      return { ok: true };
    }
    case "number": {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return { ok: false, error: `"${field.key}" must be a finite number` };
      }
      if (field.min !== undefined && n < field.min) {
        return { ok: false, error: `"${field.key}" must be >= ${field.min}` };
      }
      if (field.max !== undefined && n > field.max) {
        return { ok: false, error: `"${field.key}" must be <= ${field.max}` };
      }
      return { ok: true };
    }
    case "boolean": {
      if (typeof value !== "boolean" && value !== "true" && value !== "false") {
        return { ok: false, error: `"${field.key}" must be a boolean` };
      }
      return { ok: true };
    }
    case "select": {
      if (typeof value !== "string") {
        return { ok: false, error: `"${field.key}" must be a string` };
      }
      if (field.options && !field.options.includes(value)) {
        return { ok: false, error: `"${field.key}" must be one of: ${field.options.join(", ")}` };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `"${field.key}" has unknown type` };
  }
}

/**
 * Coerces a raw value to the correct JS type for a field descriptor.
 * Used when reading JSON-encoded values from the settings store.
 */
export function coerceSettingValue(
  field: SettingFieldDescriptor,
  raw: string
): string | number | boolean {
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : (field.default as number);
    }
    case "boolean":
      return raw === "true";
    default:
      return raw;
  }
}
