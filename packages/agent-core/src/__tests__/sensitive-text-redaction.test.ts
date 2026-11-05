import { expect, it } from "vitest";
import { buildToolPreview, redactSensitiveText } from "../tool-stream.js";

it("redacts JSON credentials while preserving formatting and unrelated prose", () => {
  const input = '{"token": "value with \\"quotes\\"", "api_key" : "another secret"}';
  const expected = '{"token": "[REDACTED]", "api_key" : "[REDACTED]"}';
  expect(redactSensitiveText(input)).toBe(expected);
  expect(buildToolPreview(input, "call").text).toBe(expected);
  expect(redactSensitiveText('{"message":"the word token is not a credential"}')).toBe(
    '{"message":"the word token is not a credential"}',
  );
  expect(redactSensitiveText("A token is issued after login.")).toBe(
    "A token is issued after login.",
  );
});

it("redacts common key variants without matching incidental substrings", () => {
  expect(
    redactSensitiveText(
      '{"TOKEN":"upper","apiKey":"camel","x-api-key":"prefixed","subscription-key":"hidden","clientSecret":"hidden","secretary":"visible"}',
    ),
  ).toBe(
    '{"TOKEN":"[REDACTED]","apiKey":"[REDACTED]","x-api-key":"[REDACTED]","subscription-key":"[REDACTED]","clientSecret":"[REDACTED]","secretary":"visible"}',
  );
});

it("redacts nested values and fails closed for truncated or empty values", () => {
  expect(redactSensitiveText('{"token": {\n  "nested": ["first", "secret"]\n}, "ok": true}')).toBe(
    '{"token": "[REDACTED]", "ok": true}',
  );
  expect(redactSensitiveText('{"token":"truncated secret')).toBe('{"token":"[REDACTED]');
  expect(redactSensitiveText('{"token":{"nested":"truncated secret"')).toBe('{"token":"[REDACTED]');
  expect(redactSensitiveText('{"token":,"ok":"visible"}')).toBe(
    '{"token":[REDACTED],"ok":"visible"}',
  );
});

it("handles escaped JSON delimiters and preserves existing secret patterns", () => {
  const escaped = '{"token":"escaped secret"}'.replace(/"/g, "\\$&");
  const expected = '{"token":"[REDACTED]"}'.replace(/"/g, "\\$&");
  expect(redactSensitiveText(escaped)).toBe(expected);
  expect(redactSensitiveText("token=hidden Bearer hidden-secret sk-1234567890")).toBe(
    "token=[REDACTED] [REDACTED] [REDACTED]",
  );
});
it("redacts assignments inside quoted diagnostics and nested serialized text", () => {
  const cases = [
    ['{"message":"password=demo-secret"}', '{"message":"password=[REDACTED]"}'],
    ['Connection failed: "token=demo-token"', 'Connection failed: "token=[REDACTED]"'],
    ["diagnostic: 'api_key=single-secret'", "diagnostic: 'api_key=[REDACTED]'"],
    ['{"message":"{\\"token\\":\\"nested-secret\\"}"}', '{"message":"{\\"token\\":\\"[REDACTED]\\"}"}'],
    ['Connection failed: "token=truncated-secret', 'Connection failed: "token=[REDACTED]'],
  ] as const;
  for (const [input, expected] of cases) expect(redactSensitiveText(input)).toBe(expected);
});
