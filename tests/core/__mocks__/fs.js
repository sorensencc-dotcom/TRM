const actualFs = jest.requireActual('fs');

// Create a mockable version of fs by defining all properties as configurable
const mockFs = {};

// Use getOwnPropertyNames to get all properties including non-enumerable ones
const propertyNames = Object.getOwnPropertyNames(actualFs);

for (const key of propertyNames) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(actualFs, key);
    if (descriptor) {
      // Redefine all properties as configurable and writable
      Object.defineProperty(mockFs, key, {
        value: actualFs[key as keyof typeof actualFs],
        writable: true,
        enumerable: descriptor.enumerable !== false,
        configurable: true,
      });
    }
  } catch (err) {
    // Skip properties that can't be accessed
  }
}

module.exports = mockFs;
