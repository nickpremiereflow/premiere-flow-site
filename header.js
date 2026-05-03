/**
 * Premiere Flow Universal Header System
 * Controls Navigation, Auth State, and Logo visibility
 */

function loadUniversalHeader() {
    const isHomePage = window.location.pathname === '/' || window.location.pathname === '/index.html' || window.location.pathname.endsWith('premiereflow.com/');
    
    const headerHTML = `
    <header class="main-top-header">
        <div class="header-left">
            <a href="/" id="header-logo-link" style="${isHomePage ? 'visibility: hidden;' : 'visibility: visible;'}">
                <img src="https://premiereflow.com/logo.png" alt="Premiere Flow" class="logo-img">
            </a>
        </div>

        <nav class="header-nav">
            <a href="/" class="nav-link ${isHomePage ? 'active' : ''}">Home</a>
            <a href="/about/" class="nav-link ${window.location.pathname.includes('/about/') ? 'active' : ''}">About</a>
            <a href="/sign-up/" class="nav-link ${window.location.pathname.includes('/sign-up/') ? 'active' : ''}">Sign Up</a>
            <div class="contact-wrapper">
                <span class="nav-link" id="contactBtn" onclick="toggleContact(event)">Contact</span>
                <div id="contactBubble" class="contact-bubble">
                    <span style="font-size: 9px; display: block; margin-bottom: 8px; color: #555; letter-spacing: 1px; text-transform: uppercase;">Support Hub</span>
                    <a href="mailto:info@premiereflow.com" class="contact-email">info@premiereflow.com</a>
                    <button class="copy-btn" onclick="copyEmail()">COPY</button>
                </div>
            </div>
            <a href="/terms/" class="nav-link ${window.location.pathname.includes('/terms/') ? 'active' : ''}">Terms</a>
        </nav>

        <div class="header-right">
            <button id="btn-header-login" class="header-btn" onclick="window.location.href='/login/'">Partner Login</button>
            <div id="header-logged-in" style="display: none; align-items: center; gap: 10px;">
                <div class="user-meta-stack">
                    <span id="header-email-display" class="user-email-text"></span>
                    <span onclick="signOut()" class="log-out-text">Log Out</span>
                </div>
                <a href="/dashboard/" class="header-btn gold-btn">Dashboard</a>
            </div>
            <button class="hamburger" onclick="toggleMobileMenu()">☰</button>
        </div>
    </header>`;

    // Inject the header at the very top of the body
    document.body.insertAdjacentHTML('afterbegin', headerHTML);
    syncAuthState();
}

function syncAuthState() {
    const savedEmail = localStorage.getItem('pf_email');
    const btnLogin = document.getElementById('btn-header-login');
    const divLoggedIn = document.getElementById('header-logged-in');
    const emailDisplay = document.getElementById('header-email-display');

    if (savedEmail && btnLogin && divLoggedIn) {
        btnLogin.style.display = 'none';
        divLoggedIn.style.display = 'flex';
        emailDisplay.innerText = savedEmail.toUpperCase();
    }
}

function signOut() {
    localStorage.removeItem('pf_email');
    localStorage.removeItem('pf_pass');
    window.location.href = '/login/';
}

function toggleMobileMenu() {
    const nav = document.querySelector('.header-nav');
    nav.classList.toggle('mobile-active');
}

function toggleContact(event) {
    event.stopPropagation();
    document.getElementById("contactBubble").classList.toggle("show");
}

function copyEmail() {
    navigator.clipboard.writeText("info@premiereflow.com");
    const btn = document.querySelector(".copy-btn");
    btn.innerText = "DONE";
    setTimeout(() => { btn.innerText = "COPY"; }, 2000);
}

// Global click listener to close the contact bubble
window.addEventListener('click', function(event) {
    const bubble = document.getElementById("contactBubble");
    const contactBtn = document.getElementById("contactBtn");
    if (bubble && bubble.classList.contains('show') && !bubble.contains(event.target) && event.target !== contactBtn) {
        bubble.classList.remove('show');
    }
});

// Run as soon as the body is ready
window.addEventListener('DOMContentLoaded', loadUniversalHeader);
