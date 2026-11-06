"use client";

import { usePathname } from "next/navigation";
import React from "react";

/**
 * Tells the page where its pinned head ends. The module's head stays at the top of the main area and its tab or filter bar pins right under it (terminal.css); the bar needs to know how tall the head is,
 * and that changes with the width and with the actions a page puts in it. This keeps `--ph-h` on the main area equal to the head's real height, across navigation and resizing.
 */
export function PinnedChrome() {
  const path = usePathname();
  React.useEffect(() => {
    const main = document.getElementById("main");
    if (!main || typeof ResizeObserver === "undefined") return;
    let head: HTMLElement | null = null;
    const set = () => main.style.setProperty("--ph-h", `${head ? head.offsetHeight : 0}px`);
    const ro = new ResizeObserver(set);
    const find = () => {
      const next = main.querySelector<HTMLElement>(":scope > .t-pagehead");
      if (next === head) return;
      if (head) ro.unobserve(head);
      head = next;
      if (head) ro.observe(head);
      set();
    };
    find();
    set();
    // A page that swaps its head (a client navigation) is found again.
    const watch = new MutationObserver(find);
    watch.observe(main, { childList: true });
    return () => {
      watch.disconnect();
      ro.disconnect();
    };
  }, [path]);
  return null;
}
