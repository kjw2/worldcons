import { permanentRedirect } from "next/navigation";

export default function RetiredAdminOperationsPage() {
  permanentRedirect("/admin");
}
