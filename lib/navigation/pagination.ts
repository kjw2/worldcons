export function paginationWindow(currentPage: number, totalPages: number, windowSize = 10) {
  const safeTotalPages = Math.max(0, Math.floor(totalPages));
  const safeWindowSize = Math.max(1, Math.floor(windowSize));
  if (safeTotalPages === 0) return [];

  const safeCurrentPage = Math.min(safeTotalPages, Math.max(1, Math.floor(currentPage)));
  const startPage = Math.floor((safeCurrentPage - 1) / safeWindowSize) * safeWindowSize + 1;
  const endPage = Math.min(safeTotalPages, startPage + safeWindowSize - 1);

  return Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);
}
