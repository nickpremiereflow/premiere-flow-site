function moveSlider(slider, containerId) {
    const container = document.getElementById(containerId);
    const afterImg = container.querySelector('.img-after');
    const line = container.querySelector('.slider-line');
    
    let val = slider.value;
    // Pushes the 'After' image reveal from the left
    afterImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    line.style.left = `${val}%`;
}

function toggleDropdown(id, cardElement) {
    const content = document.getElementById(id);
    
    // Toggle current dropdown
    const isShowing = content.classList.contains('show');
    
    // Close all first to keep it uniform
    document.querySelectorAll('.dropdown-content').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.card').forEach(el => el.classList.remove('active'));

    // Open clicked one if it wasn't already open
    if (!isShowing) {
        content.classList.add('show');
        cardElement.classList.add('active');
    }
    
    if (navigator.vibrate) navigator.vibrate(20);
}
