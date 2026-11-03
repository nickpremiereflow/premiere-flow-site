// Every field used by a Make module must be bound to its one-use authorization.
// Stable string values also avoid empty/missing and numeric coercion across Make.
export const makeFields = Object.freeze({
  account:['action','accountId','email','jobId','newName'],
  logo:['accountId','email','logoUrl'],
  engine:['action','accountId','email','jobId','expectedAttempt','vehicleName','assetSource','showroomColor','logoPlacement','thumbnail','uploadcareUrl','sendEmail'],
  services:['action','accountId','email','name','tier','totalCredits','sessionId','subject','html','commandId']
});

export function makePayload(audience, payload) {
  const fields=makeFields[audience];
  if (!fields || Object.keys(payload).some(key=>!fields.includes(key))) throw new Error('Unsupported workflow payload');
  return Object.fromEntries(fields.map(key=>[key,String(payload[key]??(audience==='engine'&&key==='sendEmail'?'true':''))]));
}
