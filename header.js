/**
 * Premiere Flow Universal Header System
 * Controls Navigation, Auth State, and Logo visibility
 */

function loadUniversalHeader() {
    const isHomePage = window.location.pathname === '/' || window.location.pathname === '/index.html' || window.location.pathname.endsWith('premiereflow.com/');
    
    // Inject state classes into the body so CSS can handle the layout perfectly
    document.body.classList.add(isHomePage ? 'state-home-page' : 'state-inner-page');

    const headerHTML = `
    <header class="main-top-header">
        <div class="header-left">
            <a href="/" id="header-logo-link" class="header-logo-el">
                <img src="https://premiereflow.com/logo.png" alt="Premiere Flow" class="logo-img">
            </a>
            
            <div class="mobile-home-auth">
                <button class="header-btn auth-logged-out" onclick="window.location.href='/login/'">Partner Login</button>
                <a href="/dashboard/" class="header-btn gold-btn auth-logged-in">Dashboard</a>
            </div>
        </div>

        <nav class="header-nav" id="global-header-nav">
            <div class="mobile-account-info mobile-hamburger-auth">
                
                <div class="auth-logged-in" style="width: 100%; display: flex; flex-direction: column; align-items: center;">
                    <span class="mobile-user-email global-email-display"></span>
                    <a href="/dashboard/" class="header-btn gold-btn" style="margin-top: 10px; width: 80%;">Dashboard</a>
                    <span onclick="signOut()" class="log-out-text" style="margin-top: 10px; font-size: 11px;">Log Out</span>
                </div>
                
                <div class="auth-logged-out" style="width: 100%; display: flex; justify-content: center;">
                     <button class="header-btn" onclick="window.location.href='/login/'" style="width: 80%;">Partner Login</button>
                </div>
                
            </div>

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
            <div class="desktop-auth-container">
                <button class="header-btn auth-logged-out" onclick="window.location.href='/login/'">Partner Login</button>
                <div class="auth-logged-in" style="display: flex; align-items: center; gap: 10px;">
                    <div class="user-meta-stack">
                        <span class="user-email-text global-email-display"></span>
                        <span onclick="signOut()" class="log-out-text">Log Out</span>
                    </div>
                    <a href="/dashboard/" class="header-btn gold-btn">Dashboard</a>
                </div>
            </div>
            
            <button class="hamburger" id="hamburger-btn" onclick="toggleMobileMenu(event)">☰</button>
        </div>
    </header>`;

    // Inject the header at the very top of the body
    document.body.insertAdjacentHTML('afterbegin', headerHTML);
    syncAuthState();
}

function syncAuthState() {
    const savedEmail = localStorage.getItem('pf_email');
    
    // JS simply checks if logged in, and applies a master class to the body.
    if (savedEmail) {
        document.body.classList.add('state-logged-in');
        document.body.classList.remove('state-logged-out');
        
        // Push email text to all display locations dynamically
        document.querySelectorAll('.global-email-display').forEach(el => {
            el.innerText = savedEmail.toLowerCase();
        });
    } else {
        document.body.classList.add('state-logged-out');
        document.body.classList.remove('state-logged-in');
    }
}

function signOut() {
    localStorage.removeItem('pf_email');
    localStorage.removeItem('pf_pass');
    window.location.href = '/login/';
}

function toggleMobileMenu(event) {
    if(event) event.stopPropagation();
    const nav = document.getElementById('global-header-nav');
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

// Global click listeners
window.addEventListener('click', function(event) {
    // Close Contact Bubble
    const bubble = document.getElementById("contactBubble");
    const contactBtn = document.getElementById("contactBtn");
    if (bubble && bubble.classList.contains('show') && !bubble.contains(event.target) && event.target !== contactBtn) {
        bubble.classList.remove('show');
    }

    // Close Mobile Menu when clicking outside
    const nav = document.getElementById('global-header-nav');
    const hamburger = document.getElementById('hamburger-btn');
    if (nav && nav.classList.contains('mobile-active') && !nav.contains(event.target) && event.target !== hamburger) {
        nav.classList.remove('mobile-active');
    }
});

// Run as soon as the body is ready
window.addEventListener('DOMContentLoaded', loadUniversalHeader);
