// >=PlayingFild Modern Trackers - Beautiful, functional key logger and mouse tracker

class ModernTrackers {
  constructor() {
    this.isInitialized = false;
    this.hasStorageListener = false;
    this.updateIntervals = new Map();
    this.lastData = {
      mouseClicks: [],
      currentWPMSession: [],
      dailyWPMData: {},
      typingSession: { startTime: null, keyCount: 0, lastKeyTime: null }
    };
  }

  // Initialize the tracking system
  async initialize() {
    if (this.isInitialized) return;
    
    try {
      await this.loadData();
      this.setupStorageListener();
      this.setupMouseTracker();
      this.isInitialized = true;
      console.log('>=PlayingFild: Modern trackers initialized');
    } catch (error) {
      console.error('>=PlayingFild: Tracker initialization failed:', error);
    }
  }

  // Load data from storage with proper error handling
  async loadData() {
    try {
      const result = await chrome.storage.local.get([
        'mouseClicks', 'currentWPMSession', 'dailyWPMData', 'typingSession'
      ]);
      
      this.lastData.mouseClicks = result.mouseClicks || [];
      this.lastData.currentWPMSession = result.currentWPMSession || [];
      this.lastData.dailyWPMData = result.dailyWPMData || {};
      this.lastData.typingSession = result.typingSession || { startTime: null, keyCount: 0, lastKeyTime: null };
      
      console.log('>=PlayingFild: Modern trackers data loaded successfully');
    } catch (error) {
      console.error('>=PlayingFild: Failed to load tracker data:', error);
      // Set default values on error
      this.lastData = {
        mouseClicks: [],
        currentWPMSession: [],
        dailyWPMData: {},
        typingSession: { startTime: null, keyCount: 0, lastKeyTime: null }
      };
    }
  }

  // Setup modern mouse tracker
  setupMouseTracker() {
    // Update initial display
    this.updateMouseTrackerDisplay();
    
    // Set up periodic updates
    this.setupPeriodicUpdate('mouseTracker', 5000, () => {
      this.updateMouseTrackerDisplay();
    });
  }

  // Update mouse tracker display
  updateMouseTrackerDisplay() {
    try {
      // Update total clicks
      const totalClicksElement = document.getElementById('totalClicks');
      if (totalClicksElement) {
        totalClicksElement.textContent = this.lastData.mouseClicks.length;
      }
      
      const mostClickedElement = document.getElementById('mostClickedArea');
      // Privacy-safe aggregate: no per-click coordinates stored or transmitted.
      if (mostClickedElement) {
        mostClickedElement.textContent = this.lastData.mouseClicks.length > 0
          ? `${this.lastData.mouseClicks.length} (aggregate)`
          : 'None';
      }
      
      // Draw beautiful heatmap
      this.drawModernHeatmap();
      
    } catch (error) {
      console.error('>=PlayingFild: Mouse tracker display update failed:', error);
    }
  }

  // Draw aggregate click summary (no coordinate heatmap — privacy-safe counters only).
  drawModernHeatmap() {
    try {
      const canvas = document.getElementById('heatmapCanvas');
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
      bgGradient.addColorStop(0, '#f8f9fa');
      bgGradient.addColorStop(1, '#e9ecef');
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, width, height);

      ctx.fillStyle = '#333';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Click activity (aggregate count)', width / 2, 25);

      const total = this.lastData?.mouseClicks?.length || 0;
      ctx.font = '24px Arial';
      ctx.fillStyle = '#5B4B9F';
      ctx.fillText(String(total), width / 2, height / 2);
      ctx.font = '12px Arial';
      ctx.fillStyle = '#666';
      ctx.fillText('No click coordinates are stored', width / 2, height / 2 + 22);
    } catch (error) {
      console.error('>=PlayingFild: Modern heatmap draw failed:', error);
    }
  }

  // Setup periodic updates
  setupPeriodicUpdate(trackerName, interval, updateFunction) {
    // Clear existing interval
    if (this.updateIntervals.has(trackerName)) {
      clearInterval(this.updateIntervals.get(trackerName));
    }
    
    // Set up new interval
    const intervalId = setInterval(() => {
      updateFunction();
    }, interval);
    
    this.updateIntervals.set(trackerName, intervalId);
  }

  setupStorageListener() {
    if (this.hasStorageListener) return;
    this.hasStorageListener = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let shouldUpdateMouseTracker = false;

      if (changes.mouseClicks) {
        this.lastData.mouseClicks = changes.mouseClicks.newValue || [];
        shouldUpdateMouseTracker = true;
      }
      if (changes.dailyWPMData) {
        this.lastData.dailyWPMData = changes.dailyWPMData.newValue || {};
      }
      if (changes.typingSession) {
        this.lastData.typingSession = changes.typingSession.newValue || { startTime: null, keyCount: 0, lastKeyTime: null };
      }
      if (changes.currentWPMSession) {
        this.lastData.currentWPMSession = changes.currentWPMSession.newValue || [];
      }

      if (shouldUpdateMouseTracker) this.updateMouseTrackerDisplay();
    });
  }
}

// Global instance
const modernTrackers = new ModernTrackers();

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModernTrackers;
} else {
  window.ModernTrackers = ModernTrackers;
  window.modernTrackers = modernTrackers;
}
