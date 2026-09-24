/**
 * Stand-in for `@cloudflare/containers`, aliased in vitest.config.ts. The real package imports
 * `cloudflare:workers`, which only exists inside workerd, and it lives in services/audio-join's own
 * node_modules, which CI does not install. This keeps just the seam `tests/unit/join-shard.test.ts`
 * needs: named instances, one `Joiner` object per name, and a `containerFetch` the test controls
 * through `globalThis.__joinTest`.
 */
export class Container {
  constructor(_ctx, env) {
    this.env = env;
    this.__name = "";
  }

  async containerFetch(_url, init) {
    const t = globalThis.__joinTest;
    t.containerCalls.push(this.__name);
    // Read the framed job to the end, as the real container does, or the Worker's pump would stall.
    await new Response(init.body).arrayBuffer();
    await t.gate(this.__name);
    const clip = new Uint8Array([1, 2, 3, 4]);
    return new Response(clip, {
      headers: { "content-type": "audio/webm", "content-length": String(clip.length), "x-join-duration-ms": "1000" },
    });
  }
}

const instances = new Map();

/** One object per name, like a Durable Object namespace — `binding` is `{ cls, env }` in the test. */
export function getContainer(binding, name = "singleton") {
  globalThis.__joinTest.touched.push(name);
  let inst = instances.get(name);
  if (!inst) {
    inst = new binding.cls({}, binding.env);
    inst.__name = name;
    instances.set(name, inst);
  }
  return { fetch: (request) => inst.fetch(request) };
}

export const __reset = () => instances.clear();
