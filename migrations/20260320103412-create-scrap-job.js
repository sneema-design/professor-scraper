"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("ScrapJobs", {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      universityName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      url: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM("pending", "running", "completed", "failed"),
        defaultValue: "pending",
      },
      totalFound: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      pagesScraped: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      startedAt: {
        type: Sequelize.DATE,
      },
      finishedAt: {
        type: Sequelize.DATE,
      },
      error: {
        type: Sequelize.TEXT,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("ScrapJobs");
  },
};