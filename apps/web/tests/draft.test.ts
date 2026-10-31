import { describe, expect, test } from "vitest";
import { DRAFT_PREFIX, DraftStore, MAX_DRAFT_CHARS, draftStorageKey, mergeDraft, rememberedQuery, sameValue } from "@/lib/draft";

/** A stand-in for the browser's storage. */
function fake(opts: { refuse?: boolean } = {}) {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => {
      if (opts.refuse) throw new Error("blocked");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.refuse) throw new Error("full");
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    raw: m
  };
}

describe("a kept draft", () => {
  test("is stored under the person and the form, so two people on one browser never see each other's", () => {
    expect(draftStorageKey("Acme:Pat", "quote:new")).toBe(`${DRAFT_PREFIX}Acme:Pat:quote:new`);
    expect(draftStorageKey("Acme:Pat", "quote:new")).not.toBe(draftStorageKey("Acme:Sam", "quote:new"));
  });

  test("comes back as it was put, with the form's starting values it was written against", () => {
    const store = new DraftStore(fake());
    const k = draftStorageKey("s", "f");
    expect(store.get(k)).toBeNull();
    expect(store.put(k, { v: { a: "1" }, base: '{"a":""}', at: 5 })).toBe(true);
    expect(store.get(k)).toEqual({ v: { a: "1" }, base: '{"a":""}', at: 5 });
    store.drop(k);
    expect(store.get(k)).toBeNull();
  });

  test("survives storage that refuses to be written or read: it is kept in memory for the tab", () => {
    const store = new DraftStore(fake({ refuse: true }));
    const k = draftStorageKey("s", "f");
    expect(() => store.put(k, { v: "typed", base: '""', at: 1 })).not.toThrow();
    expect(store.get(k)?.v).toBe("typed");
    expect(() => store.drop(k)).not.toThrow();
    expect(store.get(k)).toBeNull();
    expect(new DraftStore(null).get(k)).toBeNull();
  });

  test("is not trusted when it is not a draft: garbage in storage is no draft, never an error", () => {
    const s = fake();
    const k = draftStorageKey("s", "f");
    s.raw.set(k, "{not json");
    expect(new DraftStore(s).get(k)).toBeNull();
    s.raw.set(k, JSON.stringify({ nothing: true }));
    expect(new DraftStore(s).get(k)).toBeNull();
  });

  test("is not kept when it is too big to be a form", () => {
    const store = new DraftStore(fake());
    expect(store.put("k", { v: "x".repeat(MAX_DRAFT_CHARS), base: "", at: 1 })).toBe(false);
    expect(store.get("k")).toBeNull();
  });

  test("can be listed by person, so one person's can be found without touching another's", () => {
    const store = new DraftStore(fake());
    store.put(draftStorageKey("a", "x"), { v: 1, base: "0", at: 1 });
    store.put(draftStorageKey("a", "y"), { v: 1, base: "0", at: 1 });
    store.put(draftStorageKey("b", "x"), { v: 1, base: "0", at: 1 });
    expect(store.keys(draftStorageKey("a", "")).sort()).toEqual([draftStorageKey("a", "x"), draftStorageKey("a", "y")]);
  });
});

describe("laying kept entries over a form's starting values", () => {
  test("a field added since the draft was written has its default", () => {
    expect(mergeDraft({ a: "", b: "default" }, { a: "typed" })).toEqual({ a: "typed", b: "default" });
  });

  test("keeps lists and numbers as they were, and ignores entries of the wrong kind (a form that changed shape)", () => {
    expect(mergeDraft([1, 2], [3])).toEqual([3]);
    expect(mergeDraft([1, 2], { not: "a list" })).toEqual([1, 2]);
    expect(mergeDraft("", "typed")).toBe("typed");
    expect(mergeDraft("", 5)).toBe("");
    expect(mergeDraft({ a: "" }, "string")).toEqual({ a: "" });
    expect(mergeDraft(false, true)).toBe(true);
  });

  test("two values are the same form state when they hold the same data", () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameValue("", "")).toBe(true);
  });
});

describe("where a module was left", () => {
  test("keeps the person's search, filter and sort, and drops only how far down the list they were", () => {
    expect(rememberedQuery("?status=draft&q=acme&sort=rate&page=4")).toBe("?status=draft&q=acme&sort=rate");
    expect(rememberedQuery("status=draft")).toBe("?status=draft");
    expect(rememberedQuery("?page=2")).toBe("");
    expect(rememberedQuery("")).toBe("");
  });
});
