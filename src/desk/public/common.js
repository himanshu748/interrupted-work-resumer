let session;
async function sessionToken() {
  session ??= fetch('/api/session').then(async (response) => {
    if (!response.ok) throw new Error('Local session could not start. Reload the page.');
    return response.json();
  }).catch((error) => { session = null; throw error; });
  return (await session).token;
}
function changedSession() {
  session = null;
  return new Error('The local server session changed. Your inputs were kept; this action was not repeated. Review saved history before trying again.');
}
async function responseJson(response) {
  try { return await response.json(); }
  catch { throw new Error('The local server returned an unreadable response. Check saved history before repeating a save or provider action.'); }
}
export async function api(project, action, input = {}) {
  let response;
  try {
    response = await fetch(`/api/${project}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': await sessionToken() }, body: JSON.stringify(input),
    });
  } catch { throw new Error('Connection to the local desk was lost. Check the server and saved history before repeating a save or provider action.'); }
  // Never replay a mutation after an uncertain response or a changed session.
  if (response.status === 403) throw changedSession();
  const result = await responseJson(response);
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result;
}
export function notice(element, message, isError = false) {
  element.textContent = message;
  element.hidden = !message;
  element.dataset.error = String(isError);
  element.setAttribute('role', isError ? 'alert' : 'status');
}
export function downloadText(name, text, type = 'text/plain') {
  downloadBlob(name, new Blob([text], { type }));
}
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function el(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') element.className = value;
    else if (key === 'textContent') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked' || key === 'disabled' || key === 'selected') element[key] = Boolean(value);
    else element.setAttribute(key, String(value));
  }
  const items = Array.isArray(children) ? children : [children];
  for (const child of items) if (child !== null && child !== undefined) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
