export async function onRequestGet() {
  return new Response("ok", { headers: { "content-type": "text/plain" } });
}
