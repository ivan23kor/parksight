/**
 * Shared UI utilities for progress display and error handling.
 */

/**
 * Show progress bar with title.
 * @param {string} title - Progress title text
 * @param {boolean} indeterminate - Show indeterminate animation
 */
function showProgress(title, indeterminate = true) {
    const container = document.getElementById('progressContainer');
    const text = document.getElementById('progressText');
    const bar = document.getElementById('progressBar');
    const details = document.getElementById('progressDetails');

    text.textContent = title;
    details.textContent = '';

    if (indeterminate) {
        bar.classList.add('indeterminate');
    } else {
        bar.classList.remove('indeterminate');
        bar.style.width = '0%';
    }

    container.style.display = 'block';
    setTimeout(() => container.classList.add('visible'), 10);
}

/**
 * Update progress bar percentage and details.
 * @param {number} percent - Progress percentage (0-100)
 * @param {string} details - Additional detail text
 */
function updateProgress(percent, details = '') {
    const bar = document.getElementById('progressBar');
    const detailsEl = document.getElementById('progressDetails');

    bar.classList.remove('indeterminate');
    bar.style.width = `${percent}%`;
    detailsEl.textContent = details;
}

/**
 * Hide progress bar.
 */
function hideProgress() {
    const container = document.getElementById('progressContainer');
    container.classList.remove('visible');
    setTimeout(() => {
        container.style.display = 'none';
    }, 300);
}

/**
 * Show user-facing error message.
 * @param {string} message - Error message to display
 */
function showError(message) {
    let errorBanner = document.getElementById('errorBanner');
    if (!errorBanner) {
        errorBanner = document.createElement('div');
        errorBanner.id = 'errorBanner';
        errorBanner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: #dc3545;
            color: white;
            padding: 12px 20px;
            z-index: 2000;
            text-align: center;
            font-size: 14px;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 15px;
        `;
        document.body.prepend(errorBanner);
    }

    errorBanner.innerHTML = `
        <span>${message}</span>
        <button onclick="hideError()" style="background: white; color: #dc3545; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;">Dismiss</button>
    `;
    errorBanner.style.display = 'flex';
}

/**
 * Hide error banner.
 */
function hideError() {
    const errorBanner = document.getElementById('errorBanner');
    if (errorBanner) {
        errorBanner.style.display = 'none';
    }
}
