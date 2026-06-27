import React from 'react';

const features = [
  {
    title: "Autonomous Agent",
    description: "Doesn't just suggest code; it plans, executes, and verifies tasks autonomously within your workspace."
  },
  {
    title: "Command Execution",
    description: "Securely execute terminal commands to run builds, tests, and manage dependencies directly."
  },
  {
    title: "Web Automation",
    description: "Leverages local browsers to automate web testing, scraping, and UI verification seamlessly."
  },
  {
    title: "Deep Workspace Insight",
    description: "Understand large codebases through semantic search, regex scanning, and symbol indexing."
  }
];

const Features = () => {
  return (
    <section className="features">
      <div className="container">
        <h2 className="section-title">Core Capabilities</h2>
        <div className="features-grid">
          {features.map((feature, index) => (
            <div key={index} className="feature-card">
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
