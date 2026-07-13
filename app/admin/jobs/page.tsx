import { permanentRedirect } from "next/navigation";

export default function RetiredAdminJobsPage() {
  permanentRedirect("/admin/work?type=execution");
}
