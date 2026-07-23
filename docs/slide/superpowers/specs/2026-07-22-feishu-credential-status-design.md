# Feishu Credential Status Design

## Goal

Make the Feishu notification settings page clearly distinguish an existing saved configuration from empty replacement fields, without exposing the webhook path or signing secret.

## Current Problem

After a successful save, the component clears both sensitive inputs. This is correct for credential safety, but the two visually prominent empty fields make the saved channel look unconfigured even though the API returns a redacted endpoint and credential-presence flag.

## Design

- Keep the existing redacted API contract: `config.endpoint` identifies a saved webhook origin and `config.hasCredential` identifies a saved signing secret.
- Show separate status indicators for the webhook, signing secret, and enabled state.
- Label the inputs as replacement actions once a channel exists: `替换飞书 Webhook` and `更新签名密钥`.
- For saved values, use placeholders that state `已保存，留空不变`; never place a saved webhook path or secret in an input value.
- After saving, update the local status immediately and continue clearing the submitted sensitive values.
- Preserve the existing behavior in which an empty replacement field leaves the stored value unchanged.
- Keep the existing test-message action as the operational proof that the saved configuration is valid.

## Error Handling

- New channels still require a valid `open.feishu.cn` webhook and signing secret.
- Existing channels validate only replacement values that the administrator enters.
- Failed saves retain the entered replacement values so the administrator can correct and retry them.
- Successful saves clear the replacement values and show the saved-state indicators.

## Verification

- Component tests cover loading an existing redacted channel, the three displayed statuses, replacement-field labels/placeholders, save payloads, and immediate post-save status.
- Existing non-Feishu URL rejection remains covered.
- Frontend typecheck and focused tests must pass.
- Browser verification confirms that saved credentials look configured while their values remain absent from the DOM.

## Non-Goals

- Revealing or partially revealing the webhook path or signing secret.
- Changing notification API DTOs or database storage.
- Adding a multi-step editor, credential deletion flow, or channel history.
