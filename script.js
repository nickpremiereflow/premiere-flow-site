function moveSlider(slider, containerId) {
    const container = document.getElementById(containerId);
    const afterImg = container.querySelector('.img-after');
    const line = container.querySelector('.slider-line');
    
    let val = slider.value;
    afterImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    line.style.left = `${val}%`;
}

function toggleDropdown(id, cardElement) {
    const content = document.getElementById(id);
    const wasShowing = content.classList.contains('show');
    
    document.querySelectorAll('.dropdown-content').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.card').forEach(el => el.classList.remove('active'));

    if (!wasShowing) {
        content.classList.add('show');
        cardElement.classList.add('active');
    }
}
