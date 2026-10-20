/**
 * Test helper (not a test) — find the elements of one component type in the
 * tree a Server Component page RETURNS, without rendering it (the pages are
 * async and their children are client components with their own tests).
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";

export function findElements<P>(node: ReactNode, type: (props: P) => unknown): Array<ReactElement<P>> {
  const out: Array<ReactElement<P>> = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    if (n.type === type) out.push(n as ReactElement<P>);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}
