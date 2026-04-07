// Handles the Before/After Slider movement
function moveSlider(slider, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return; // Safety check

    const afterImg = container.querySelector('.img-after');
    const line = container.querySelector('.slider-line');
    
    let val = slider.value;
    
    // Updates the clip-path to show the "After" image
    afterImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    // Moves the vertical white line
    line.style.left = `${val}%`;
}

// Handles the Pricing Card Dropdowns
function toggleDropdown(id, cardElement) {
    const content = document.getElementById(id);
    const wasShowing = content.classList.contains('show');
    
    // Close all other dropdowns first for a clean accordion effect
    document.querySelectorAll('.dropdown-content').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.card').forEach(el => el.classList.remove('active'));

    // If it wasn't open, open it
    if (!wasShowing) {
        content.classList.add('show');
        cardElement.classList.add('active');
    }
}
