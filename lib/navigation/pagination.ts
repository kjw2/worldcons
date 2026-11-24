export function paginationWindow(currentPage: number, totalPages: number, windowSize = 10) {
  const safeTotalPages = Math.max(0, Math.floor(totalPages));
  const safeWindowSize = Math.max(1, Math.floor(windowSize));
  if (safeTotalPages === 0) return [];

  const safeCurrentPage = Math.min(safeTotalPages, Math.max(1, Math.floor(currentPage)));
  const startPage = Math.floor((safeCurrentPage - 1) / safeWindowSize) * safeWindowSize + 1;
  const endPage = Math.min(safeTotalPages, startPage + safeWindowSize - 1);

  return Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);
}

/**
 * Link targets for one pagination control row. A boundary control has no
 * target (`null`) so callers render plain text instead of a dead link; every
 * numeric target is clamped to a real page, even when a caller requests a page
 * past the computed end.
 */
export function paginationControls(currentPage: number, totalPages: number, windowSize = 10) {
  const safeTotalPages = Math.max(1, Math.floor(totalPages));
  const safeCurrentPage = Math.max(1, Math.floor(currentPage));
  return {
    previousPage: safeCurrentPage > 1 ? Math.min(safeCurrentPage - 1, safeTotalPages) : null,
    nextPage: safeCurrentPage < safeTotalPages ? safeCurrentPage + 1 : null,
    pages: paginationWindow(safeCurrentPage, safeTotalPages, windowSize)
      .filter((page) => page >= 1 && page <= safeTotalPages),
  };
}
