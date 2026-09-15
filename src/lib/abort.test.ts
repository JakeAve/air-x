import { assert, assertEquals } from "@std/assert";
import { anySignal } from "./abort.ts";

Deno.test("anySignal aborts when any input aborts, once", () => {
  const a = new AbortController();
  const b = new AbortController();
  const signal = anySignal(a.signal, b.signal);
  let aborts = 0;
  signal.addEventListener("abort", () => aborts++);
  assert(!signal.aborted);
  b.abort();
  a.abort();
  assert(signal.aborted);
  assertEquals(aborts, 1);
});

Deno.test("anySignal is aborted already when an input is", () => {
  const a = new AbortController();
  a.abort();
  assert(anySignal(new AbortController().signal, a.signal).aborted);
});
