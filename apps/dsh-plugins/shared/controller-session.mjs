// Controller records use a reserved namespace for Desktop conversations.
// This is an opt-in mapping, not a Host lease or a credential boundary.
export const DESKTOP_SESSION_PREFIX = 'desktop:';

export function controllerSessionMode(config) {
  const mode = config?.controllerSessionNamespace;
  if (mode === undefined || mode === 'web') return 'web';
  if (mode === 'desktop') return mode;
  throw new Error('controllerSessionNamespace must be web or desktop.');
}

export function controllerSessionId(raw, mode = 'web') {
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() || /[^\x21-\x7e]/.test(raw)) throw new Error('Invalid conversation identity.');
  if (mode === 'web') {
    if (raw.startsWith(DESKTOP_SESSION_PREFIX) || raw.length > 160) throw new Error('Reserved or oversized Web conversation identity.');
    return raw;
  }
  // Search's durable session ledger is stricter than the production store:
  // every mapped Desktop identity must fit its 150-character limit as well.
  if (mode !== 'desktop' || raw.length + DESKTOP_SESSION_PREFIX.length > 150) throw new Error('Invalid Desktop conversation identity.');
  return DESKTOP_SESSION_PREFIX + raw;
}

export function withControllerSessionNamespace(base, { allowUnknown = false, allowedKeys = [] } = {}) {
  const schema = base['~standard'];
  return Object.freeze({'~standard': Object.freeze({version:schema.version,vendor:schema.vendor,validate(value) {
    try {
      controllerSessionMode(value);
      if (!allowUnknown && Object.keys(value ?? {}).some(key => !['runtimeRoot','controllerSessionNamespace',...allowedKeys].includes(key))) throw new Error('Unknown plugin configuration field.');
      const result=schema.validate(value);
      return result;
    } catch(error) { return {issues:[{message:error.message,path:['controllerSessionNamespace']}]}; }
  }})});
}
