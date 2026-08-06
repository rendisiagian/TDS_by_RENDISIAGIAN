// Server-Side Pagination Utility
// Usage: initPagination(config) where config = { containerId, onPageChange }

function renderPagination(containerId, total, page, limit) {
    var el = document.getElementById(containerId);
    if (!el) return;
    
    var totalPages = limit > 0 ? Math.ceil(total / limit) : 1;
    if (totalPages < 1) totalPages = 1;
    
    var from = total === 0 ? 0 : ((page - 1) * limit + 1);
    var to = Math.min(page * limit, total);
    if (limit >= total) { from = total > 0 ? 1 : 0; to = total; }
    
    var html = '<div class="pg-bar">';
    
    // Info
    html += '<div class="pg-info">Menampilkan <b>' + from + '-' + to + '</b> dari <b>' + total + '</b> data</div>';
    
    // Rows per page
    html += '<div class="pg-rpp">';
    html += '<span>Per halaman:</span>';
    html += '<select id="' + containerId + '-rpp" onchange="window.__pgChangeLimit(\'' + containerId + '\', this.value)">';
    [10, 25, 50, 100].forEach(function(n) {
        html += '<option value="' + n + '"' + (n === limit ? ' selected' : '') + '>' + n + '</option>';
    });
    html += '<option value="all"' + (limit >= total && total > 0 ? ' selected' : '') + '>Semua</option>';
    html += '</select>';
    html += '</div>';
    
    // Page buttons
    html += '<div class="pg-btns">';
    html += '<button class="pg-btn" onclick="window.__pgGo(\'' + containerId + '\',' + 1 + ')"' + (page <= 1 ? ' disabled' : '') + '>&laquo;</button>';
    html += '<button class="pg-btn" onclick="window.__pgGo(\'' + containerId + '\',' + (page - 1) + ')"' + (page <= 1 ? ' disabled' : '') + '>&lsaquo;</button>';
    
    // Page numbers
    var startP = Math.max(1, page - 2);
    var endP = Math.min(totalPages, page + 2);
    if (startP > 1) html += '<span class="pg-dots">...</span>';
    for (var i = startP; i <= endP; i++) {
        html += '<button class="pg-btn' + (i === page ? ' pg-active' : '') + '" onclick="window.__pgGo(\'' + containerId + '\',' + i + ')">' + i + '</button>';
    }
    if (endP < totalPages) html += '<span class="pg-dots">...</span>';
    
    html += '<button class="pg-btn" onclick="window.__pgGo(\'' + containerId + '\',' + (page + 1) + ')"' + (page >= totalPages ? ' disabled' : '') + '>&rsaquo;</button>';
    html += '<button class="pg-btn" onclick="window.__pgGo(\'' + containerId + '\',' + totalPages + ')"' + (page >= totalPages ? ' disabled' : '') + '>&raquo;</button>';
    html += '</div>';
    
    html += '</div>';
    el.innerHTML = html;
}

// Global pagination state per container
window.__pgState = {};

window.__pgGo = function(containerId, page) {
    var state = window.__pgState[containerId];
    if (state && state.onPageChange) {
        state.page = page;
        state.onPageChange(page, state.limit);
    }
};

window.__pgChangeLimit = function(containerId, val) {
    var state = window.__pgState[containerId];
    if (state && state.onPageChange) {
        state.limit = val === 'all' ? 'all' : parseInt(val);
        state.page = 1;
        state.onPageChange(1, state.limit);
    }
};

function initPagination(containerId, onPageChange, defaultLimit) {
    window.__pgState[containerId] = {
        page: 1,
        limit: defaultLimit || 25,
        onPageChange: onPageChange
    };
}
