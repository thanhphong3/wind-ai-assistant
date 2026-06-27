import React from 'react';
import './index.css';
import Hero from './components/Hero';
import Features from './components/Features';
import About from './components/About';
import Footer from './components/Footer';

function App() {
  return (
    <div className="app">
      <Hero />
      <Features />
      <About />
      <Footer />
    </div>
  );
}

export default App;
