export default function AdminWorkLoading() {
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6" role="status" aria-live="polite">
      <div className="h-7 w-56 animate-pulse rounded-md bg-rule" />
      <div className="mt-6 grid gap-2 border-y border-rule bg-white py-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-14 animate-pulse bg-parchment" />)}
      </div>
      <span className="sr-only">관리자 업무 큐 불러오는 중</span>
    </div>
  );
}
