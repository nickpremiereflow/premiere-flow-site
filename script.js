function moveSlider(slider, containerId) {
    const container = document.getElementById(containerId);
    const beforeImg = container.querySelector('.img-before');
    const line = container.querySelector('.slider-line');
    
    let val = slider.value;
    // Pushes the 'Before' image edge to reveal the 'After' image underneath
    beforeImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    line.style.left = `${val}%`;
}

function toggleDropdown(id) {
    const content = document.getElementById(id);
    content.classList.toggle('show');
}
