// Entirely synthetic telemetry. These values are not a real Copilot usage/unit verification.
export const TRACE = '11111111111111111111111111111111';
export const id = number => Number(number).toString(16).padStart(16, '0');
export const attr = (key, value, kind = 'stringValue') => ({ key, value: { [kind]: value } });
export const nanos = date => (BigInt(Date.parse(date)) * 1_000_000n).toString();

export function span(number = 1, overrides = {}) {
  const { cost = '2500000000', session = 'synthetic-session', operation = 'invoke_agent',
    model = 'synthetic-model-a', attributes = [], ...fields } = overrides;
  return {
    traceId: TRACE, spanId: id(number),
    startTimeUnixNano: nanos('2026-09-15T12:00:00.000Z'),
    endTimeUnixNano: nanos('2026-09-15T12:00:01.000Z'),
    attributes: [attr('gen_ai.operation.name', operation), attr('gen_ai.conversation.id', session),
      ...(cost === null ? [] : [attr('github.copilot.nano_aiu', cost, 'intValue')]),
      attr('server.address', 'api.example.test'), attr('server.port', '443', 'intValue'),
      attr('gen_ai.response.model', model), attr('gen_ai.usage.input_tokens', '10', 'intValue'),
      attr('gen_ai.usage.output_tokens', '4', 'intValue'), ...attributes],
    ...fields,
  };
}

export function envelope(spans = [span()], version = '1.0.88') {
  return { resourceSpans: [{ resource: { attributes: [attr('service.version', version)] },
    scopeSpans: [{ scope: { name: 'synthetic-test-fixture' }, spans }] }] };
}
