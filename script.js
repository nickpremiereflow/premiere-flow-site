// Auto Slider Logic
const autoSlider = document.getElementById('autoSlider');
const autoAfter = document.querySelector('.img-after');

if (autoSlider) {
    autoSlider.oninput = function() {
        autoAfter.style.clipPath = `inset(0 ${100 - this.value}% 0 0)`;
    };
}

// Haptic Feedback
function triggerHaptic() {
    if (navigator.vibrate) {
        navigator.vibrate(40); 
    }
}
