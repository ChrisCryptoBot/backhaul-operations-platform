/**
 * Any URL that is not a load closes the drawer. Without this, a soft navigation leaves the slot showing the load it had
 * last (Next keeps a parallel slot's content when the new URL does not match it).
 */
export default function CloseDrawer() {
  return null;
}
