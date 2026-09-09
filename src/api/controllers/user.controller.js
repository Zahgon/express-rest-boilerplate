const httpStatus = require('http-status');
const { omit } = require('lodash');
const User = require('../models/user.model');

/**
 * Load user and append to req.
 * @public
 */
exports.load = async (req) => {
  const user = await User.get(req.params.userId);
  req.locals = { user };
};

/**
 * Get user
 * @public
 */
exports.get = (req, res) => res.json(req.locals.user.transform());

/**
 * Get logged in user info
 * @public
 */
exports.loggedIn = (req, res) => res.json(req.user.transform());

/**
 * Create new user
 * @public
 */
exports.create = async (req, res) => {
  try {
    const user = new User(req.body);
    const savedUser = await user.save();
    res.status(httpStatus.CREATED);
    return res.json(savedUser.transform());
  } catch (error) {
    throw User.checkDuplicateEmail(error);
  }
};

/**
 * Replace existing user
 * @public
 */
exports.replace = async (req, res) => {
  try {
    const { user } = req.locals;
    const newUser = new User(req.body);
    const ommitRole = user.role !== 'admin' ? 'role' : '';
    const newUserObject = omit(newUser.toObject(), '_id', ommitRole);

    await user.updateOne(newUserObject, { override: true, upsert: true });
    const savedUser = await User.findById(user._id);

    return res.json(savedUser.transform());
  } catch (error) {
    throw User.checkDuplicateEmail(error);
  }
};

/**
 * Update existing user
 * @public
 */
exports.update = (req, res) => {
  const ommitRole = req.locals.user.role !== 'admin' ? 'role' : '';
  const updatedUser = omit(req.body, ommitRole);
  const user = Object.assign(req.locals.user, updatedUser);

  return user.save()
    .then((savedUser) => res.json(savedUser.transform()))
    .catch((e) => {
      throw User.checkDuplicateEmail(e);
    });
};

/**
 * Get user list
 * @public
 */
exports.list = async (req, res) => {
  const users = await User.list(req.query);
  const transformedUsers = users.map((user) => user.transform());
  return res.json(transformedUsers);
};

/**
 * Delete user
 * @public
 */
exports.remove = (req, res) => {
  const { user } = req.locals;

  return user.remove()
    .then(() => res.status(httpStatus.NO_CONTENT).send());
};
