/**
 * ToolRegistry — dynamic tool registration and execution.
 * Direct port of nanobot/nanobot/agent/tools/registry.py.
 */

import { readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  JsonSchemaProperty as JSP,
  Tool,
  ToolRegistry as IToolRegistry,
  ToolSchema,
} from "./types.js";

// Re-export for convenience
export type { JSP as JsonSchemaProperty };

export class ToolRegistry implements IToolRegistry {
  private _tools = new Map<string, Tool>();
  private _cachedDefinitions: ToolSchema[] | null = null;

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
    this._cachedDefinitions = null;
  }

  unregister(name: string): void {
    this._tools.delete(name);
    this._cachedDefinitions = null;
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  getDefinitions(): ToolSchema[] {
    if (this._cachedDefinitions) return this._cachedDefinitions;

    const defs: ToolSchema[] = [];
    for (const tool of this._tools.values()) {
      defs.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }

    // Stable sort: builtins first, MCP tools sorted after
    defs.sort((a, b) => {
      const aMcp = a.name.startsWith("mcp_");
      const bMcp = b.name.startsWith("mcp_");
      if (aMcp !== bMcp) return aMcp ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    this._cachedDefinitions = defs;
    return defs;
  }

  get toolNames(): string[] {
    return [...this._tools.keys()];
  }

  /** Resolve, cast, and validate one tool call. Returns [tool, castParams, error]. */
  prepareCall(
    name: string,
    params: Record<string, unknown>
  ): { tool: Tool | null; params: Record<string, unknown>; error: string | null } {
    if (!(params && typeof params === "object" && !Array.isArray(params))) {
      return {
        tool: null,
        params,
        error: `Tool '${name}' parameters must be a JSON object, got ${typeof params}`,
      };
    }

    const tool = this._tools.get(name);
    if (!tool) {
      return {
        tool: null,
        params,
        error: `Tool '${name}' not found. Available: ${this.toolNames.join(", ")}`,
      };
    }

    const castParams = tool.castParams ? tool.castParams(params) : params;
    const errors = validateJsonSchema(castParams, tool.parameters, "");
    if (errors.length > 0) {
      return {
        tool,
        params: castParams,
        error: `Invalid parameters for tool '${name}': ${errors.join("; ")}`,
      };
    }

    return { tool, params: castParams, error: null };
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const HINT = "\n\n[Analyze the error above and try a different approach.]";
    const { tool, params: castParams, error } = this.prepareCall(name, params);

    if (error) return error + HINT;

    try {
      const result = await tool!.execute(castParams);
      if (typeof result === "string" && result.startsWith("Error")) {
        return result + HINT;
      }
      return result;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return `Error executing ${name}: ${message}${HINT}`;
    }
  }

  get size(): number {
    return this._tools.size;
  }
}

// ── JSON Schema validation (ported from nanobot Schema class) ──

const JSON_TYPE_MAP: Record<string, string | [string, string]> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
  array: "array",
  object: "object",
};

function resolveJsonSchemaType(t: unknown): string | null {
  if (Array.isArray(t)) {
    return (t.find((x) => x !== "null") as string) || null;
  }
  return typeof t === "string" ? t : null;
}

export function validateJsonSchema(
  val: unknown,
  schema: Record<string, unknown>,
  path: string
): string[] {
  const rawType = schema.type;
  const nullable =
    (Array.isArray(rawType) && rawType.includes("null")) || schema.nullable === true;
  const t = resolveJsonSchemaType(rawType);
  const label = path || "parameter";

  if (nullable && val === null) return [];

  if (t === "integer" && (typeof val !== "number" || !Number.isInteger(val))) {
    return [`${label} should be integer`];
  }
  if (t === "number" && typeof val !== "number") {
    return [`${label} should be number`];
  }
  if (t === "string" && typeof val !== "string") return [`${label} should be string`];
  if (t === "boolean" && typeof val !== "boolean") return [`${label} should be boolean`];
  if (t === "array" && !Array.isArray(val)) return [`${label} should be array`];
  if (t === "object" && (typeof val !== "object" || val === null || Array.isArray(val))) {
    return [`${label} should be object`];
  }

  const errors: string[] = [];
  const subpath = (key: string) => (path ? `${path}.${key}` : key);

  if (schema.enum && !(schema.enum as unknown[]).includes(val)) {
    errors.push(`${label} must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ((t === "integer" || t === "number") && typeof val === "number") {
    if (typeof schema.minimum === "number" && val < schema.minimum) {
      errors.push(`${label} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && val > schema.maximum) {
      errors.push(`${label} must be <= ${schema.maximum}`);
    }
  }
  if (t === "string" && typeof val === "string") {
    if (typeof schema.minLength === "number" && val.length < schema.minLength) {
      errors.push(`${label} must be at least ${schema.minLength} chars`);
    }
    if (typeof schema.maxLength === "number" && val.length > schema.maxLength) {
      errors.push(`${label} must be at most ${schema.maxLength} chars`);
    }
  }
  if (t === "object" && typeof val === "object" && val !== null && !Array.isArray(val)) {
    const props = (schema.properties as Record<string, Record<string, unknown>>) || {};
    for (const k of (schema.required as string[]) || []) {
      if (!(k in val)) errors.push(`missing required ${subpath(k)}`);
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k in props) {
        errors.push(...validateJsonSchema(v, props[k], subpath(k)));
      }
    }
  }
  if (t === "array" && Array.isArray(val)) {
    if (typeof schema.minItems === "number" && val.length < schema.minItems) {
      errors.push(`${label} must have at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && val.length > schema.maxItems) {
      errors.push(`${label} must be at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      for (let i = 0; i < val.length; i++) {
        errors.push(
          ...validateJsonSchema(
            val[i],
            schema.items as Record<string, unknown>,
            path ? `${path}[${i}]` : `[${i}]`
          )
        );
      }
    }
  }

  return errors;
}

// ── Tool parameter casting (ported from nanobot Tool._cast_value) ──

export function castToolParams(
  params: Record<string, unknown>,
  schema: ToolSchema["parameters"]
): Record<string, unknown> {
  if (schema.type !== "object") return params;

  const props = schema.properties || {};
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(params)) {
    if (key in props) {
      result[key] = castValue(val, props[key]);
    } else {
      result[key] = val;
    }
  }

  return result;
}

function castValue(val: unknown, propSchema: JSP): unknown {
  const t = resolveJsonSchemaType(propSchema.type);

  // Already correct type
  if (t === "boolean" && typeof val === "boolean") return val;
  if (t === "integer" && typeof val === "number" && Number.isInteger(val)) return val;
  if (t === "number" && typeof val === "number") return val;
  if (t === "string" && typeof val === "string") return val;

  // String → number coercion
  if (typeof val === "string" && (t === "integer" || t === "number")) {
    const n = t === "integer" ? parseInt(val, 10) : parseFloat(val);
    if (!isNaN(n)) return n;
  }

  // Any → string coercion
  if (t === "string" && val !== null && val !== undefined) return String(val);

  // String → boolean coercion
  if (t === "boolean" && typeof val === "string") {
    const low = val.toLowerCase();
    if (["true", "1", "yes"].includes(low)) return true;
    if (["false", "0", "no"].includes(low)) return false;
  }

  // Array with item schema
  if (t === "array" && Array.isArray(val) && propSchema.items) {
    return val.map((x) => castValue(x, propSchema.items!));
  }

  // Object with property schemas
  if (
    t === "object" &&
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    propSchema.properties
  ) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k in propSchema.properties) {
        result[k] = castValue(v, propSchema.properties[k]);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  return val;
}

// ── Tool auto-discovery utilities (ported from nanobot tools/loader.py) ──

const TOOL_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs']);
const SKIP_FILES = new Set(['index.ts', 'index.js', 'types.ts', 'types.js', 'schema.ts', 'schema.js']);

/**
 * Scan a directory for tool files (.js, .ts, .mjs, .cjs).
 * Returns resolved file paths.
 */
export function scanToolDir(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const ext = extname(entry);
      if (!TOOL_EXTENSIONS.has(ext)) continue;
      if (SKIP_FILES.has(entry)) continue;
      results.push(resolve(dirPath, entry));
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return results.sort();
}

/**
 * Dynamically import tool files from a directory and collect exported Tool objects.
 * Each file is expected to export Tool-compatible objects (either as named exports
 * or as default export). Side-effect register() calls on import are also supported.
 */
export async function importToolsFromDir(dirPath: string): Promise<Tool[]> {
  const files = scanToolDir(dirPath);
  const tools: Tool[] = [];
  const seen = new Set<string>();

  for (const filePath of files) {
    try {
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl);

      // Collect Tool exports (named exports and default)
      for (const [key, value] of Object.entries(mod)) {
        if (key === 'default') continue;
        if (isToolLike(value)) {
          const tool = value as Tool;
          if (!seen.has(tool.name)) {
            seen.add(tool.name);
            tools.push(tool);
          }
        }
      }

      // Check default export
      const defaultExport = mod['default'];
      if (defaultExport && isToolLike(defaultExport)) {
        const tool = defaultExport as Tool;
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          tools.push(tool);
        }
      }
    } catch {
      // Silently skip files that fail to import
    }
  }

  return tools;
}

function isToolLike(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return typeof t['name'] === 'string' && typeof t['execute'] === 'function';
}

