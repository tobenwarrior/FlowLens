// A hygiene guard for recognized credential parameter names, not an arbitrary-secret detector.
// Callers still review URLs and notes before sharing evidence.
const CREDENTIAL_PARAMETER =
  /^(?:(?:xamz|xgoog)?(?:apikey|apitoken|accesskey|accesskeyid|accesstoken|refreshtoken|idtoken|token|authtoken|sessiontoken|securitytoken|authorization|auth|authcode|authorizationcode|password|passwd|secret|secretkey|clientsecret|clientassertion|privatekey|signature|sig|credential|credentials|bearer|key)|aws(?:accesskeyid|secretaccesskey))$/i;

export function isCredentialParameterName(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[-_.\s]/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "");
  return CREDENTIAL_PARAMETER.test(normalized);
}
