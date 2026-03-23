'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Professor extends Model {
    static associate(models) {
      Professor.belongsTo(models.ScrapJob, {
        foreignKey: "jobId",
        as: "job",
      });
    }
  }

  Professor.init({
    jobId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
    },
    department: {
      type: DataTypes.STRING,
    },
    email: {
      type: DataTypes.STRING,
    },
    phone: {
      type: DataTypes.STRING,
    },
    research: {
      type: DataTypes.TEXT,
    },
    profileUrl: {
      type: DataTypes.STRING,
    },
  }, {
    sequelize,
    modelName: 'Professor',
    timestamps: true, // Sequelize handles createdAt & updatedAt
  });

  return Professor;
};