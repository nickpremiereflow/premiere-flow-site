function moveSlider(slider, containerId) {
    const container = document.getElementById(containerId);
    const beforeImg = container.querySelector('.img-before');
    const line = container.querySelector('.slider-line');
    
    let val = slider.value;
    beforeImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    line.style.left = `${val}%`;
}

function toggleDropdown(id, cardElement) {
    const content = document.getElementById(id);
    content.classList.toggle('show');
    cardElement.classList.toggle('active');
    
    if (navigator.vibrate) navigator.vibrate(20);
}
